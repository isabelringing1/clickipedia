-- MySQL dump 10.19  Distrib 10.3.38-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: fixture    Database: tinywiki
-- ------------------------------------------------------
-- This file deliberately uses the legacy layout: every tuple of an INSERT on
-- one line, as Wikimedia dumps were written before 2025.

/*!40101 SET NAMES utf8mb4 */;

--
-- Table structure for table `redirect`
--

DROP TABLE IF EXISTS `redirect`;
CREATE TABLE `redirect` (
  `rd_from` int(8) unsigned NOT NULL DEFAULT 0,
  `rd_namespace` int(11) NOT NULL DEFAULT 0,
  `rd_title` varbinary(255) NOT NULL DEFAULT '',
  `rd_interwiki` varbinary(32) DEFAULT NULL,
  `rd_fragment` varbinary(255) DEFAULT NULL,
  PRIMARY KEY (`rd_from`),
  KEY `rd_ns_title` (`rd_namespace`,`rd_title`,`rd_from`)
) ENGINE=InnoDB DEFAULT CHARSET=binary ROW_FORMAT=COMPRESSED;

--
-- Dumping data for table `redirect`
--

LOCK TABLES `redirect` WRITE;
/*!40000 ALTER TABLE `redirect` DISABLE KEYS */;
INSERT INTO `redirect` VALUES (3,0,'Incremental_game','',''),(4,0,'Idle_game','',''),(5,0,'Loop_B','',''),(6,0,'Loop_A','',''),(12,0,'Incremental_game','',''),(13,0,'Nonexistent_page','','');
INSERT INTO `redirect` VALUES (14,1,'Incremental_game','',''),(15,0,'Jeu_incrémental','fr',NULL),(18,0,'Self_redirect','',''),(22,0,'Café',NULL,NULL),(23,0,'Cookie_Clicker','','History'),(999,0,'Incremental_game','','');
/*!40000 ALTER TABLE `redirect` ENABLE KEYS */;
UNLOCK TABLES;

-- Dump completed on 2026-01-01  0:00:00
