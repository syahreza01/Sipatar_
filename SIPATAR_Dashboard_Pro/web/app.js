(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const API_BASE = location.pathname.includes("/web/") ? "../api/" : "api/";
  const STORE = "sipatar_pro_v2";
  const DEFAULT = {
    demoMode: false, cameraUrl: "", snapshotUrl: "", pollMs: 3000,
    gasThreshold: 400, gasFireThreshold: 680, tempThreshold: 50,
    humidityMinThreshold: 30, humidityMaxThreshold: 80, flameAlertEnabled: true,
    telegramEnabled: false, telegramChat: "",
    telegramRules: {warning:true, fire:true, offline:true, recovery:false},
    users: [
      {id:1,name:"Administrator",username:"admin",role:"Administrator",active:true},
      {id:2,name:"Operator Lapangan",username:"operator",role:"Operator",active:true},
      {id:3,name:"Pengamat",username:"viewer",role:"Viewer",active:true}
    ],
    events: [
      {id:1,time:new Date(Date.now()-1000*60*8).toISOString(),location:"Greenhouse - Zona A",description:"Monitoring berjalan normal",severity:"Aman",operator:"Sistem"},
      {id:2,time:new Date(Date.now()-1000*60*32).toISOString(),location:"Greenhouse - Zona B",description:"Pemeriksaan sensor berkala",severity:"Aman",operator:"Operator"},
      {id:3,time:new Date(Date.now()-1000*60*75).toISOString(),location:"Ruang Peralatan",description:"Uji fungsi notifikasi",severity:"Waspada",operator:"Admin"}
    ],
    audit: [], telegramLog: [],
    history: []
  };
  let state = loadState();
  let currentUser = null, pollTimer = null, chartResizeTimer = null, sensorConnection = null;
  let cameraSnapshotCount = 0;
  const roles = {
    Administrator: ["dashboard","grafik","kamera","perangkat","laporan","acl","telegram","pengaturan"],
    Operator: ["dashboard","grafik","kamera","perangkat","laporan"],
    Viewer: ["dashboard","grafik","kamera","laporan"]
  };
  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if(!saved)return structuredClone(DEFAULT);
      const loaded={...structuredClone(DEFAULT),...saved,
        users:saved.users||structuredClone(DEFAULT.users),events:saved.events||structuredClone(DEFAULT.events),
        history:saved.history||structuredClone(DEFAULT.history),telegramRules:{...DEFAULT.telegramRules,...saved.telegramRules}};
      Object.keys(loaded).forEach(key=>{if(!Object.prototype.hasOwnProperty.call(DEFAULT,key))delete loaded[key];});
      const lastSample=loaded.history[loaded.history.length-1];
      if(saved.demoMode===false&&lastSample&&lastSample.source!=="laragon")loaded.history=[];
      return loaded;
    } catch { return structuredClone(DEFAULT); }
  }
  function saveState() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch(e) { toast("Tidak dapat menyimpan data browser.", "error"); } }
  function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function fmtTime(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("id-ID",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}); }
  function toast(message, type="success") {
    const el = document.createElement("div"); el.className = `toast ${type}`; el.textContent = message; $("toastRegion").appendChild(el);
    setTimeout(()=>el.remove(),3600);
  }
  function audit(action) { state.audit.unshift({time:new Date().toISOString(),action,user:currentUser?.username||"anonim"}); state.audit=state.audit.slice(0,12); saveState(); renderAudit(); }
  function roleAllowed(page) { return currentUser && (roles[currentUser.role]||[]).includes(page); }
  function showLogin() { $("loginView").classList.remove("hidden"); $("appShell").classList.add("hidden"); }
  function showApp() { $("loginView").classList.add("hidden"); $("appShell").classList.remove("hidden"); updateUserUI(); navigate("dashboard"); startPolling(); }
  function updateUserUI() {
    const name = currentUser?.name || "Admin";
    $("currentUser").textContent=name; $("welcomeName").textContent=name.split(" ")[0]; $("currentRole").textContent=currentUser?.role||"Administrator"; $("userInitial").textContent=name.charAt(0).toUpperCase();
    document.querySelectorAll(".nav-link[data-page]").forEach(btn=>{ const allowed=roleAllowed(btn.dataset.page); btn.classList.toggle("restricted",!allowed); btn.style.display=allowed?"flex":"none"; });
  }
  function navigate(page) {
    if (!roleAllowed(page)) { toast("Akun ini tidak memiliki izin untuk membuka halaman tersebut.","error"); return; }
    document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${page}`));
    document.querySelectorAll(".nav-link[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    const labels={dashboard:"Dashboard Monitoring",grafik:"Grafik Sensor",kamera:"Kamera ESP32-CAM",perangkat:"Perangkat & Sensor",laporan:"Laporan Kejadian",acl:"Access Control List",telegram:"Telegram Bot",pengaturan:"Pengaturan"};
    $("pageTitle").textContent=labels[page]||"SIPATAR"; $("pageCrumb").textContent=labels[page]||page;
    $("sidebar").classList.remove("open");
    if(page==="dashboard") { renderDashboard(); drawMiniChart(); }
    if(page==="grafik") { drawFullChart(); drawHumidityChart(); }
    if(page==="kamera") { renderCamera(); loadCameraSnapshots(); }
    if(page==="perangkat") renderDevices();
    if(page==="laporan") renderReports();
    if(page==="acl") { renderUsers(); renderAudit(); }
  }
  function statusNow() {
    const latestByZone=latestSamplesByZone();
    const newest=state.history[state.history.length-1];
    const latest=state.demoMode?(newest||{temp:28,humidity:60,gas:180,flame:false}):
      newest&&Date.now()-newest.t<45000?newest:null;
    const monitored=state.demoMode?(latest?[latest]:[]):Object.values(latestByZone).filter(sample=>Date.now()-sample.t<45000);
    if(!latest)return {latest:null,fire:false,warn:false,label:"Belum ada data",noData:true};
    const fireZones=monitored.filter(sample=>(state.flameAlertEnabled&&sample.flame===true)||sample.gas>=state.gasFireThreshold||(sample.temp!==null&&sample.temp>=state.tempThreshold)).map(sample=>sample.zone||"zona1");
    const warnZones=monitored.filter(sample=>sample.gas>=state.gasThreshold||(sample.humidity!==null&&(sample.humidity<state.humidityMinThreshold||sample.humidity>state.humidityMaxThreshold))).map(sample=>sample.zone||"zona1");
    const fire=fireZones.length>0;
    const warn=!fire&&warnZones.length>0;
    return {latest, fire, warn, alertZones:fire?fireZones:warnZones, label:fire?"Kebakaran":warn?"Waspada":"Aman",noData:!state.demoMode&&monitored.length===0};
  }
  function renderDashboard() {
    const {latest,fire,warn,alertZones,label,noData}=statusNow();
    renderZoneCard("zone1",latestSamplesByZone().zona1);
    renderZoneCard("zone2",latestSamplesByZone().zona2);
    $("currentDate").textContent=new Date().toLocaleDateString("id-ID",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
    const banner=$("riskBanner"); banner.className="alert-banner"+(noData||warn?" warning":fire?" danger":"");
    $("bannerTitle").textContent=noData?"Data sensor belum diterima":fire?"Indikasi bahaya terdeteksi":warn?"Pembacaan sensor di luar ambang":"Sistem dalam kondisi normal";
    $("bannerText").textContent=noData?"Belum ada pembacaan dari ESP8266 Zona 1 atau Zona 2. Periksa koneksi Laragon dan konfigurasi perangkat.":fire?`Periksa lokasi segera (${alertZones.join(", ").toUpperCase()}). Ini indikator monitoring, verifikasi kondisi fisik.`:warn?`Periksa pembacaan sensor (${alertZones.join(", ").toUpperCase()}).`:"Tidak ada indikasi bahaya pada data saat ini.";
    $("bannerBadge").textContent=noData?"OFFLINE":label.toUpperCase(); $("bannerBadge").className="status-badge "+(noData||warn?"warning":fire?"danger":"safe");
    $("recentEvents").innerHTML=state.events.slice(0,5).map(e=>`<tr><td>${escapeHTML(fmtTime(e.time))}</td><td>${escapeHTML(e.location)}</td><td>${escapeHTML(e.description)}</td><td><span class="level-pill ${escapeHTML(e.severity)}">${escapeHTML(e.severity)}</span></td><td>${escapeHTML(e.operator)}</td></tr>`).join("")||'<tr><td colspan="5">Belum ada kejadian.</td></tr>';
    $("topMode").textContent=state.demoMode?"SIMULASI":"LARAGON";
    $("sideConnection").textContent=state.demoMode?"Data simulasi aktif":sensorConnection===true?"Database Laragon tersambung":sensorConnection===false?"Database Laragon tidak terjangkau":"Menunggu koneksi Laragon";
    renderCameraPreview();
  }
  function latestSamplesByZone(){
    return state.history.reduce((latest,sample)=>{
      const zone=sample.zone||"zona1";
      if(!latest[zone]||sample.t>=latest[zone].t)latest[zone]=sample;
      return latest;
    },{});
  }
  function renderZoneCard(zoneId,sample){
    const online=Boolean(sample&&Date.now()-sample.t<45000);
    const status=$(zoneId+"Status");
    if(status){status.textContent=state.demoMode?"SIMULASI":online?"ONLINE":"OFFLINE";status.className="status-badge "+(online||state.demoMode?"safe":"neutral");}
    const temp=$(zoneId+"Temp");if(temp)temp.textContent=sample&&sample.temp!==null?Number(sample.temp).toFixed(1)+" °C":zoneId==="zone2"&&sample?"Tidak tersedia":"— °C";
    const humidity=$(zoneId+"Humidity");if(humidity)humidity.textContent=sample&&sample.humidity!==null?Number(sample.humidity).toFixed(0)+" %":zoneId==="zone2"&&sample?"Tidak tersedia":"— %";
    const gas=$(zoneId+"Gas");if(gas)gas.textContent=sample?Number(sample.gas)+" ADC":"— ADC";
    const flame=$(zoneId+"Flame");if(flame)flame.textContent=sample?(sample.flame?"Terdeteksi":"Tidak terdeteksi"):"Belum ada data";
    const time=$(zoneId+"Time");if(time)time.textContent=sample?`Terakhir diterima ${fmtTime(new Date(sample.t).toISOString())}`:"Belum menerima data";
  }
  function renderCameraPreview() {
    const url=state.cameraUrl;
    $("cameraStatus").textContent=url?"URL stream dikonfigurasi":"Belum terhubung";
    $("cameraBadge").textContent=url?"URL DIATUR":"OFFLINE"; $("cameraBadge").className="status-badge "+(url?"safe":"neutral");
    $("cameraUrlLabel").textContent=url||"URL belum dikonfigurasi";
    $("miniCamera").innerHTML=url?`<img src="${escapeHTML(url)}" alt="Live stream ESP32-CAM" onerror="this.style.display='none';this.parentElement.innerHTML='<div class=&quot;camera-placeholder&quot;><b>Stream belum dapat dimuat</b><small>Periksa IP kamera dan jaringan.</small></div>'">`:'<div class="camera-placeholder"><span class="camera-symbol">▣</span><b>Feed kamera belum tersedia</b><small>Atur IP ESP32-CAM pada menu Kamera.</small></div>';
  }
  function renderCamera() {
    $("cameraInput").value=state.cameraUrl||""; $("snapshotInput").value=state.snapshotUrl||"";
    $("cameraPageBadge").textContent=state.cameraUrl?"URL DIATUR":"BELUM DIATUR"; $("cameraPageBadge").className="status-badge "+(state.cameraUrl?"safe":"neutral");
    $("cameraPageStatus").textContent=state.cameraUrl?"Stream disiapkan. Jika gambar kosong, buka URL langsung untuk tes.":"Menunggu konfigurasi URL kamera.";
    $("cameraPageUrl").textContent=state.cameraUrl||"—";
    $("cameraStage").innerHTML=state.cameraUrl?`<img src="${escapeHTML(state.cameraUrl)}" alt="Live stream ESP32-CAM" onerror="this.style.display='none';this.parentElement.innerHTML='<div class=&quot;camera-placeholder&quot;><b>Stream gagal dimuat</b><small>Periksa alamat, daya kamera, dan koneksi Wi-Fi.</small></div>'">`:'<div class="camera-placeholder"><span class="camera-symbol">▣</span><b>Kamera belum dikonfigurasi</b><small>Isi URL stream pada panel pengaturan di sebelah kanan.</small></div>';
  }
  function renderDevices() {
    const latest=latestSamplesByZone();
    const online=(sample)=>sample&&Date.now()-sample.t<45000;
    const devices=[
      {name:"ESP8266 · Zona 1",type:"Sensor flame, MQ-2, DHT22",ip:latest.zona1?`Data terakhir ${fmtTime(latest.zona1.t)}`:"Belum ada data",status:state.demoMode?"SIMULASI":online(latest.zona1)?"ONLINE":"OFFLINE",icon:"⌘"},
      {name:"ESP8266 · Zona 2",type:"Sensor flame, MQ-2 (tanpa DHT22)",ip:latest.zona2?`Data terakhir ${fmtTime(latest.zona2.t)}`:"Belum ada data",status:state.demoMode?"SIMULASI":online(latest.zona2)?"ONLINE":"OFFLINE",icon:"⌘"},
      {name:"ESP32-CAM AI Thinker",type:"Live stream · snapshot tersimpan di Laragon",ip:state.cameraUrl||"Stream belum diatur",status:cameraSnapshotCount?"SNAPSHOT AKTIF":"BELUM ADA FOTO",icon:"▣"}
    ];
    $("deviceGrid").innerHTML=devices.map(d=>`<article class="device-card"><div class="device-top"><div class="device-symbol">${d.icon}</div><span class="status-badge ${d.status==="SIMULASI"||d.status==="ONLINE"||d.status==="SNAPSHOT AKTIF"?"safe":"neutral"}">${d.status}</span></div><h3>${escapeHTML(d.name)}</h3><p>${escapeHTML(d.type)}</p><div class="device-meta"><span>Status / data</span><b>${escapeHTML(d.ip)}</b></div></article>`).join("");
    $("pollInput").value=state.pollMs; $("dataMode").value=state.demoMode?"demo":"laragon";
  }
  function renderReports() {
    const q=$("reportSearch").value.toLowerCase(), severity=$("severityFilter").value, range=$("reportRange").value;
    const today=new Date().toDateString();
    const filtered=state.events.filter(e=>(!q||`${e.location} ${e.description} ${e.operator}`.toLowerCase().includes(q))&&(severity==="all"||e.severity===severity)&&(range!=="today"||new Date(e.time).toDateString()===today));
    $("reportTotal").textContent=state.events.length; $("reportWarn").textContent=state.events.filter(e=>e.severity==="Waspada").length; $("reportFire").textContent=state.events.filter(e=>e.severity==="Kebakaran").length;
    $("reportRows").innerHTML=filtered.map(e=>`<tr><td>${escapeHTML(fmtTime(e.time))}</td><td>${escapeHTML(e.location)}</td><td>${escapeHTML(e.description)}</td><td><span class="level-pill ${escapeHTML(e.severity)}">${escapeHTML(e.severity)}</span></td><td>${escapeHTML(e.operator)}</td><td><button class="action-btn" data-delete-event="${e.id}" aria-label="Hapus kejadian">Hapus</button></td></tr>`).join("")||'<tr><td colspan="6">Tidak ada data yang cocok dengan filter.</td></tr>';
    $("reportShowing").textContent=`Menampilkan ${filtered.length} dari ${state.events.length} data`;
  }
  function renderUsers() {
    $("userRows").innerHTML=state.users.map(u=>`<tr><td><div class="user-name"><span class="avatar">${escapeHTML(u.name.charAt(0).toUpperCase())}</span><span><b>${escapeHTML(u.name)}</b><br><span class="muted">@${escapeHTML(u.username)}</span></span></div></td><td>${escapeHTML(u.role)}</td><td>${(roles[u.role]||[]).length} halaman</td><td><span class="status-badge ${u.active?"safe":"neutral"}">${u.active?"AKTIF":"NONAKTIF"}</span></td><td><button class="action-btn" data-toggle-user="${u.id}">${u.active?"Nonaktifkan":"Aktifkan"}</button><button class="action-btn" data-role-user="${u.id}">Ganti peran</button></td></tr>`).join("");
  }
  function renderAudit() {
    $("auditList").innerHTML=state.audit.length?state.audit.slice(0,8).map(a=>`<div class="audit-item"><div><b>${escapeHTML(a.action)}</b><br><span>${escapeHTML(a.user)}</span></div><span>${escapeHTML(fmtTime(a.time))}</span></div>`).join(""):'<p class="muted tiny">Belum ada aktivitas sesi.</p>';
  }
  function renderTelegramLog() {
    $("telegramLog").innerHTML=state.telegramLog.length?state.telegramLog.slice(0,6).map(a=>`<div class="audit-item"><div><b>${escapeHTML(a.message)}</b><br><span>${escapeHTML(a.status)}</span></div><span>${escapeHTML(fmtTime(a.time))}</span></div>`).join(""):'<p class="muted tiny">Belum ada uji notifikasi.</p>';
  }
  function drawChart(canvasId, series, labels, maxY, grid=true) {
    const canvas=$(canvasId); if(!canvas) return;
    const rect=canvas.getBoundingClientRect(); if(rect.width<10)return;
    const dpr=window.devicePixelRatio||1, width=rect.width, height=Number(canvas.getAttribute("height"))||220;
    canvas.width=Math.floor(width*dpr); canvas.height=Math.floor(height*dpr); canvas.style.height=height+"px";
    const ctx=canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const pad={l:38,r:12,t:12,b:28}, cw=width-pad.l-pad.r,ch=height-pad.t-pad.b;
    const css=getComputedStyle(document.body), muted=css.getPropertyValue("--muted").trim()||"#8da0b8", line=css.getPropertyValue("--line").trim()||"#24364c";
    ctx.font="10px DM Sans, sans-serif";ctx.textAlign="right";ctx.textBaseline="middle";
    if(grid){for(let i=0;i<=4;i++){const y=pad.t+ch*i/4;ctx.strokeStyle=line;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(width-pad.r,y);ctx.stroke();ctx.fillStyle=muted;ctx.fillText(String(Math.round(maxY*(1-i/4))),pad.l-8,y);}}
    series.forEach(s=>{ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.beginPath();let drawing=false;s.values.forEach((v,i)=>{if(!Number.isFinite(v)){drawing=false;return;}const x=pad.l+(s.values.length<=1?0:i*cw/(s.values.length-1));const y=pad.t+ch-(Math.max(0,Math.min(maxY,v))/maxY)*ch;if(drawing)ctx.lineTo(x,y);else ctx.moveTo(x,y);drawing=true});ctx.stroke();s.values.forEach((v,i)=>{if(!Number.isFinite(v))return;const x=pad.l+(s.values.length<=1?0:i*cw/(s.values.length-1));const y=pad.t+ch-(Math.max(0,Math.min(maxY,v))/maxY)*ch;ctx.fillStyle=s.color;ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();});});
    ctx.fillStyle=muted;ctx.textAlign="center";ctx.textBaseline="top";const count=labels.length;[0,Math.floor((count-1)/2),count-1].forEach(i=>{if(i>=0&&labels[i]!==undefined){const x=pad.l+(count<=1?0:i*cw/(count-1));ctx.fillText(labels[i],x,height-20);}});
  }
  function selectedHistory(){const n=Number($("chartRange")?.value||10),zone=$("chartZone")?.value||"all";const data=zone==="all"?state.history:state.history.filter(sample=>(sample.zone||"zona1")===zone);return data.slice(-n);}
  function drawMiniChart(){const data=state.history.slice(-10);drawChart("miniChart",[{values:data.map(d=>d.temp),color:"#4389ff"},{values:data.map(d=>d.gas/15),color:"#ffb454"}],data.map((d,i)=>i%3===0?new Date(d.t).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}):""),50);}
  function drawFullChart(){const data=selectedHistory(),temperatures=data.map(d=>d.temp).filter(value=>Number.isFinite(value));$("avgTemp").textContent=temperatures.length?(temperatures.reduce((a,v)=>a+v,0)/temperatures.length).toFixed(1):"—";$("maxGas").textContent=data.length?Math.max(...data.map(d=>d.gas)):"—";$("dataCount").textContent=data.length;drawChart("fullChart",[{values:data.map(d=>d.temp),color:"#4389ff"},{values:data.map(d=>d.gas/20),color:"#ffb454"}],data.map((d,i)=>i%Math.max(1,Math.floor(data.length/5))===0?new Date(d.t).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}):""),50);}
  function drawHumidityChart(){const data=selectedHistory();drawChart("humidityChart",[{values:data.map(d=>d.humidity),color:"#2dcc91"}],data.map((d,i)=>i%Math.max(1,Math.floor(data.length/5))===0?new Date(d.t).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}):""),100);}
  async function loadCameraSnapshots(){
    const container=$("cameraSnapshots");
    try{
      const response=await fetch(API_BASE+"camera.php?limit=12",{cache:"no-store"});
      const result=await response.json();
      if(!response.ok||!result.ok||!Array.isArray(result.snapshots))throw new Error(result.error||"HTTP "+response.status);
      cameraSnapshotCount=result.snapshots.length;
      container.innerHTML=result.snapshots.length?result.snapshots.map(snapshot=>{
        const id=Number(snapshot.id),time=escapeHTML(fmtTime(String(snapshot.created_at||"").replace(" ","T")));
        return `<a class="snapshot-card" href="${API_BASE}camera.php?id=${id}" target="_blank" rel="noopener noreferrer"><img src="${API_BASE}camera.php?id=${id}" alt="Snapshot ESP32-CAM ${time}" loading="lazy"><span>${time}</span></a>`;
      }).join(""):'<p class="muted tiny">Belum ada snapshot. Pastikan ESP32-CAM sudah mengirim foto ke Laragon.</p>';
      renderDevices();
    }catch(error){
      cameraSnapshotCount=0;
      container.innerHTML=`<p class="muted tiny">${escapeHTML(error.message)}. Periksa Laragon dan database.</p>`;
      renderDevices();
    }
  }
  function pushDemoSample() {
    if(!state.demoMode)return;
    const latest=latestSamplesByZone();
    const now=Date.now();
    const prev1=latest.zona1||{temp:28,humidity:60,gas:200};
    const prev2=latest.zona2||{temp:null,humidity:null,gas:180};
    const temp1=+(Math.max(22,Math.min(65,prev1.temp+(Math.random()-.5)*1.1))).toFixed(1);
    const humidity=Math.round(Math.max(35,Math.min(90,prev1.humidity+(Math.random()-.5)*3)));
    const gas1=Math.round(Math.max(80,Math.min(900,prev1.gas+(Math.random()-.5)*35)));
    const gas2=Math.round(Math.max(80,Math.min(900,prev2.gas+(Math.random()-.5)*35)));
    state.history.push({t:now,zone:"zona1",temp:temp1,humidity,gas:gas1,flame:false});
    state.history.push({t:now,zone:"zona2",temp:null,humidity:null,gas:gas2,flame:false});
    if(state.history.length>120)state.history=state.history.slice(-120);
    saveState();renderDashboard();
    if($("page-grafik").classList.contains("active")){drawFullChart();drawHumidityChart();}
  }
    async function pollSensors() {
    if(state.demoMode){pushDemoSample();return;}
    try{
      // Menambahkan parameter waktu agar browser tidak menggunakan cache
      const res = await fetch(API_BASE + "readings.php?limit=120&t=" + Date.now(), {cache: "no-store"});
      const data = await res.json();
      
      if(!res.ok || !data.ok || !Array.isArray(data.readings)) {
        throw new Error(data.error || "Respons API Laragon tidak valid (HTTP " + res.status + ").");
      }

      // MEMBACA DATA DENGAN LEBIH AMAN
      const readings = data.readings.map(row => {
        let timeMs = Number(row.timestamp_ms);
        // Jika timestamp_ms gagal dibaca, coba baca dari created_at
        if (!Number.isFinite(timeMs) && row.created_at) {
            timeMs = new Date(String(row.created_at).replace(" ", "T")).getTime();
        }

        return {
          id: Number(row.id),
          zone: String(row.zone),
          t: timeMs,
          temp: (row.temperature === null || row.temperature === undefined) ? null : Number(row.temperature),
          humidity: (row.humidity === null || row.humidity === undefined) ? null : Number(row.humidity),
          gas: Number(row.gas),
          flame: Number(row.flame_detected) === 1,
          source: "laragon"
        };
      }).filter(sample => 
        Number.isFinite(sample.id) && 
        Number.isFinite(sample.t) && 
        ["zona1","zona2"].includes(sample.zone) &&
        Number.isFinite(sample.gas)
      );

      const recovered = sensorConnection === false;
      sensorConnection = true;
      
      // Menggabungkan data baru tanpa duplikasi
      const byId = new Map(readings.map(sample => [sample.id, sample]));
      let updated = false;
      const existing = state.history.map(sample => {
        const current = byId.get(Number(sample.id));
        if(!current) return sample;
        
        if(sample.zone !== current.zone || 
           sample.t !== current.t || 
           sample.temp !== current.temp ||
           sample.humidity !== current.humidity || 
           sample.gas !== current.gas || 
           sample.flame !== current.flame) {
             updated = true;
        }
        return current;
      });
      
      const knownIds = new Set(existing.map(sample => Number(sample.id)).filter(Number.isFinite));
      const fresh = readings.filter(sample => !knownIds.has(sample.id));
      
      if(fresh.length || updated){
        state.history = [...existing, ...fresh].sort((a,b) => a.t - b.t);
        if(state.history.length > 500) state.history = state.history.slice(-500);
        saveState();
      }
      
      renderDashboard();
      renderDevices();
      
      if(recovered) toast("Koneksi database Laragon pulih.");
      if(fresh.length && $("page-dashboard").classList.contains("active")) drawMiniChart();
      if(fresh.length && $("page-grafik").classList.contains("active")) {
        drawFullChart();
        drawHumidityChart();
      }
    } catch(e) {
      const firstFailure = sensorConnection !== false;
      sensorConnection = false;
      $("sideConnection").textContent = "Database Laragon tidak terjangkau";
      renderDashboard();
      renderDevices();
      if(firstFailure) {
        toast("Gagal membaca data Laragon: " + e.message, "error");
      }
    }
  }
  function startPolling(){
    clearInterval(pollTimer);pollTimer=null;
    sensorConnection=null;
    pollSensors();
    pollTimer=setInterval(pollSensors,Math.max(1000,Number(state.pollMs)||3000));
  }
  function csvCell(value){return '"'+String(value??"").replace(/"/g,'""')+'"';}
  function exportCSV(){
    const rows=[["Waktu","Lokasi","Kejadian","Level","Petugas"],...state.events.map(e=>[new Date(e.time).toLocaleString("id-ID"),e.location,e.description,e.severity,e.operator])];
    const csv="\uFEFF"+rows.map(r=>r.map(csvCell).join(",")).join("\r\n");
    downloadBlob(csv,"sipatar-laporan.csv","text/csv;charset=utf-8");toast("Laporan CSV berhasil disiapkan.");
  }
  function downloadBlob(content,filename,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);}
  function bindEvents(){
    $("loginForm").addEventListener("submit",e=>{e.preventDefault();const username=$("loginUsername").value.trim(),password=$("loginPassword").value;const user=state.users.find(u=>u.username.toLowerCase()===username.toLowerCase()&&u.active);if(username==="admin"&&password==="sipatar123"&&user){currentUser=user;$("loginError").textContent="";audit("Login berhasil");showApp();}else if(user&&((username==="operator"&&password==="operator123")||(username==="viewer"&&password==="viewer123"))){currentUser=user;$("loginError").textContent="";audit("Login berhasil");showApp();}else{$("loginError").textContent="Username atau password salah, atau akun nonaktif.";}}); 
    document.querySelectorAll(".nav-link[data-page]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.page)));
    document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.go)));
    $("mobileMenu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
    $("themeToggle").addEventListener("click",()=>{document.body.classList.toggle("light");localStorage.setItem("sipatar_theme",document.body.classList.contains("light")?"light":"dark");toast("Tema tampilan diperbarui.");});
    $("userMenu").addEventListener("click",()=>toast(`Akun: ${currentUser?.username} · Peran: ${currentUser?.role}`));
    const logout=()=>{audit("Logout");currentUser=null;clearInterval(pollTimer);showLogin();};
    $("sidebarLogout").addEventListener("click",logout);$("logoutSettings").addEventListener("click",logout);
    $("cameraForm").addEventListener("submit",e=>{e.preventDefault();const url=$("cameraInput").value.trim();if(!/^https?:\/\//i.test(url)){toast("URL kamera harus diawali http:// atau https://","error");return;}state.cameraUrl=url;state.snapshotUrl=$("snapshotInput").value.trim();saveState();renderCamera();renderCameraPreview();toast("URL kamera disimpan. Jika gambar tidak muncul, uji URL langsung di browser.");});
    $("clearCamera").addEventListener("click",()=>{state.cameraUrl="";state.snapshotUrl="";saveState();renderCamera();renderCameraPreview();toast("Konfigurasi kamera dihapus.");});
    $("openStream").addEventListener("click",()=>{if(!state.cameraUrl){toast("Masukkan URL stream terlebih dahulu.","error");return;}window.open(state.cameraUrl,"_blank","noopener,noreferrer");});
    $("sensorConfigForm").addEventListener("submit",e=>{e.preventDefault();const wasDemo=state.demoMode;state.pollMs=Math.max(1000,Number($("pollInput").value)||3000);state.demoMode=$("dataMode").value==="demo";if(wasDemo!==state.demoMode)state.history=[];sensorConnection=null;saveState();renderDevices();startPolling();renderDashboard();toast("Konfigurasi sumber sensor disimpan.");});
    $("testSensorApi").addEventListener("click",async()=>{try{if($("dataMode").value==="demo"){toast("Mode simulasi aktif.");return;}const response=await fetch(API_BASE+"readings.php?limit=1",{cache:"no-store"});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||"HTTP "+response.status);toast(result.readings.length?"Laragon terhubung. Data sensor terbaru berhasil dibaca.":"Laragon terhubung; menunggu data dari ESP8266.");}catch(error){toast("Uji koneksi gagal: "+error.message,"error");}});
    $("chartRange").addEventListener("change",()=>{drawFullChart();drawHumidityChart();});$("chartZone").addEventListener("change",()=>{drawFullChart();drawHumidityChart();});$("refreshChart").addEventListener("click",()=>{drawFullChart();drawHumidityChart();toast("Grafik diperbarui.");});
    $("refreshSnapshots").addEventListener("click",loadCameraSnapshots);
    $("reportSearch").addEventListener("input",renderReports);$("severityFilter").addEventListener("change",renderReports);$("reportRange").addEventListener("change",renderReports);$("resetFilters").addEventListener("click",()=>{$("reportSearch").value="";$("severityFilter").value="all";$("reportRange").value="all";renderReports();});
    $("exportCsv").addEventListener("click",exportCSV);
    $("addEvent").addEventListener("click",()=>{if(!$("eventDialog").showModal){toast("Browser tidak mendukung dialog.","error");return;}$("eventDialog").showModal();});
    $("eventForm").addEventListener("submit",e=>{e.preventDefault();state.events.unshift({id:Date.now(),time:new Date().toISOString(),location:$("eventLocation").value.trim(),description:$("eventDescription").value.trim(),severity:$("eventSeverity").value,operator:$("eventOperator").value.trim()});saveState();$("eventDialog").close();renderReports();renderDashboard();toast("Kejadian berhasil dicatat.");});
    $("reportRows").addEventListener("click",e=>{const b=e.target.closest("[data-delete-event]");if(!b)return;const id=Number(b.dataset.deleteEvent);if(confirm("Hapus kejadian ini dari data demo?")){state.events=state.events.filter(x=>x.id!==id);saveState();renderReports();renderDashboard();toast("Kejadian dihapus.");}});
    $("clearReports").addEventListener("click",()=>{if(confirm("Hapus semua laporan demo? Tindakan ini tidak dapat dibatalkan.")){state.events=[];saveState();renderReports();renderDashboard();toast("Semua laporan demo dihapus.");}});
    $("addUser").addEventListener("click",()=>$("userDialog").showModal());
    $("userForm").addEventListener("submit",e=>{e.preventDefault();const username=$("newUsername").value.trim();if(state.users.some(u=>u.username.toLowerCase()===username.toLowerCase())){toast("Username sudah digunakan.","error");return;}const user={id:Date.now(),name:$("newUserName").value.trim(),username,role:$("newUserRole").value,active:true};state.users.push(user);saveState();$("userDialog").close();renderUsers();updateUserUI();toast("Pengguna ditambahkan ke ACL lokal.");audit("Tambah pengguna: "+username);});
    $("userRows").addEventListener("click",e=>{const toggle=e.target.closest("[data-toggle-user]"),role=e.target.closest("[data-role-user]");if(toggle){const u=state.users.find(x=>x.id===Number(toggle.dataset.toggleUser));if(!u)return;if(u.username===currentUser?.username&&u.active){toast("Akun yang sedang digunakan tidak dapat dinonaktifkan.","error");return;}u.active=!u.active;saveState();renderUsers();toast("Status akun diperbarui.");audit("Ubah status akun: "+u.username);}if(role){const u=state.users.find(x=>x.id===Number(role.dataset.roleUser));if(!u)return;const choices=["Administrator","Operator","Viewer"],next=choices[(choices.indexOf(u.role)+1)%choices.length];u.role=next;saveState();renderUsers();updateUserUI();toast(`Peran ${u.username} menjadi ${next}.`);audit("Ubah peran: "+u.username);}});
    $("telegramForm").addEventListener("submit",e=>{e.preventDefault();state.telegramChat=$("telegramChat").value.trim();state.telegramEnabled=$("telegramEnabled").checked;saveState();toast("Pengaturan Telegram disimpan lokal. Token bot tidak disimpan.");$("telegramBadge").textContent=state.telegramEnabled?"DIKONFIGURASI":"NONAKTIF";$("telegramBadge").className="status-badge "+(state.telegramEnabled?"safe":"neutral");});
    $("testTelegram").addEventListener("click",async()=>{
      const token=$("telegramToken").value.trim(), chat=$("telegramChat").value.trim();
      if(!token||!chat){toast("Isi Bot token dan Chat ID terlebih dahulu.","error");return;}
      const button=$("testTelegram");button.disabled=true;
      try{
        const response=await fetch(API_BASE+"telegram-test.php",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token,chatId:chat})});
        const result=await response.json();
        if(!response.ok||!result.ok)throw new Error(result.error||"Pengiriman pesan gagal.");
        const entry={time:new Date().toISOString(),message:"Pesan uji berhasil dikirim ke "+chat,status:"BERHASIL"};
        state.telegramLog.unshift(entry);state.telegramLog=state.telegramLog.slice(0,12);saveState();renderTelegramLog();
        $("telegramBadge").textContent="TERKIRIM";$("telegramBadge").className="status-badge safe";
        toast("Pesan uji berhasil dikirim ke Telegram.");
      }catch(error){
        const message=error instanceof TypeError
          ?"Layanan Telegram tidak terjangkau. Pastikan Apache dan ekstensi cURL PHP aktif di Laragon."
          :error.message;
        state.telegramLog.unshift({time:new Date().toISOString(),message:"Uji ke "+chat,status:"GAGAL — "+message});
        state.telegramLog=state.telegramLog.slice(0,12);saveState();renderTelegramLog();
        $("telegramBadge").textContent="GAGAL";$("telegramBadge").className="status-badge danger";
        toast("Uji Telegram gagal: "+message,"error");
      }finally{$("telegramToken").value="";button.disabled=false;}
    });
    $("telegramRules").addEventListener("submit",e=>{e.preventDefault();state.telegramRules={warning:$("notifyWarning").checked,fire:$("notifyFire").checked,offline:$("notifyOffline").checked,recovery:$("notifyRecovery").checked};saveState();toast("Aturan notifikasi disimpan.");});
    $("thresholdForm").addEventListener("submit",e=>{
      e.preventDefault();
      const gasThreshold=Number($("gasThreshold").value), gasFireThreshold=Number($("gasFireThreshold").value);
      const humidityMinThreshold=Number($("humidityMinThreshold").value), humidityMaxThreshold=Number($("humidityMaxThreshold").value);
      if(gasFireThreshold<=gasThreshold){toast("Ambang gas bahaya harus lebih tinggi dari ambang waspada.","error");return;}
      if(humidityMaxThreshold<=humidityMinThreshold){toast("Kelembapan maksimum harus lebih tinggi dari minimum.","error");return;}
      state.gasThreshold=gasThreshold;state.gasFireThreshold=gasFireThreshold;
      state.tempThreshold=Number($("tempThreshold").value);
      state.humidityMinThreshold=humidityMinThreshold;state.humidityMaxThreshold=humidityMaxThreshold;
      state.flameAlertEnabled=$("flameAlertEnabled").checked;
      saveState();renderDashboard();toast("Ambang sensor dashboard diperbarui.");
    });
    $("downloadBackup").addEventListener("click",()=>{downloadBlob(JSON.stringify({...state,telegramToken:undefined},null,2),"sipatar-backup.json","application/json");toast("Backup JSON dibuat.");});
    $("resetDemo").addEventListener("click",()=>{if(confirm("Reset data demo dan konfigurasi lokal?")){localStorage.removeItem(STORE);state=structuredClone(DEFAULT);saveState();renderDashboard();renderReports();renderUsers();renderDevices();renderCamera();renderTelegramLog();toast("Data demo dikembalikan ke kondisi awal.");}});
    document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.close).close()));
    ["eventDialog","userDialog"].forEach(id=>$(id).addEventListener("click",e=>{if(e.target===$(id))$(id).close();}));
    window.addEventListener("resize",()=>{clearTimeout(chartResizeTimer);chartResizeTimer=setTimeout(()=>{if($("page-dashboard").classList.contains("active"))drawMiniChart();if($("page-grafik").classList.contains("active")){drawFullChart();drawHumidityChart();}},120);});
  }
  function init(){
    if(localStorage.getItem("sipatar_theme")==="light")document.body.classList.add("light");
    $("gasThreshold").value=state.gasThreshold;$("gasFireThreshold").value=state.gasFireThreshold;
    $("tempThreshold").value=state.tempThreshold;$("humidityMinThreshold").value=state.humidityMinThreshold;
    $("humidityMaxThreshold").value=state.humidityMaxThreshold;$("flameAlertEnabled").checked=state.flameAlertEnabled;
    $("telegramChat").value=state.telegramChat;$("telegramEnabled").checked=state.telegramEnabled;
    $("notifyWarning").checked=state.telegramRules.warning;$("notifyFire").checked=state.telegramRules.fire;$("notifyOffline").checked=state.telegramRules.offline;$("notifyRecovery").checked=state.telegramRules.recovery;
    bindEvents();renderTelegramLog();renderDashboard();renderReports();renderUsers();renderDevices();
    $("topMode").textContent=state.demoMode?"SIMULASI":"LARAGON";
    // Initial local demo login makes the dashboard immediately previewable.
    currentUser=state.users.find(u=>u.username==="admin"&&u.active)||state.users.find(u=>u.active);
    if(currentUser){showApp();}else{showLogin();}
    setTimeout(()=>{drawMiniChart();},100);
  }
  init();
})();