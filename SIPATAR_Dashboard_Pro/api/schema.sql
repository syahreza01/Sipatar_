CREATE DATABASE IF NOT EXISTS sipatar
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE sipatar;

CREATE TABLE IF NOT EXISTS sensor_readings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id ENUM('zona1', 'zona2') NOT NULL,
  temperature DECIMAL(6, 2) NULL DEFAULT NULL,
  humidity DECIMAL(5, 2) NULL DEFAULT NULL,
  gas SMALLINT UNSIGNED NOT NULL,
  flame_detected TINYINT(1) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sensor_device_created (device_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS camera_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_camera_filename (filename),
  KEY idx_camera_created (created_at)
) ENGINE=InnoDB;
