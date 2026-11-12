/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19  Distrib 10.11.18-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: fixture    Database: tinywiki
-- ------------------------------------------------------

/*!40101 SET NAMES utf8mb4 */;

--
-- Table structure for table `pagelinks`
--

DROP TABLE IF EXISTS `pagelinks`;
CREATE TABLE `pagelinks` (
  `pl_from` int(8) unsigned NOT NULL DEFAULT 0,
  `pl_from_namespace` int(11) NOT NULL DEFAULT 0,
  `pl_target_id` bigint(20) unsigned NOT NULL,
  PRIMARY KEY (`pl_from`,`pl_target_id`),
  KEY `pl_target_id` (`pl_target_id`,`pl_from`),
  KEY `pl_backlinks_namespace_target_id` (`pl_from_namespace`,`pl_target_id`,`pl_from`)
) ENGINE=InnoDB DEFAULT CHARSET=binary ROW_FORMAT=COMPRESSED;

--
-- Dumping data for table `pagelinks`
--

/*!40000 ALTER TABLE `pagelinks` DISABLE KEYS */;
INSERT INTO `pagelinks` VALUES
(1,0,6),
(1,0,15),
(10,1,101),
(1,0,101),
(11,0,101),
(1,0,102),
(2,0,103),
(2,0,104),
(3,0,104),
(7,0,104),
(17,0,104),
(24,10,104),
(999,0,104),
(1,0,105),
(1,0,107);
INSERT INTO `pagelinks` VALUES
(8,0,107),
(1,0,108),
(7,0,108),
(2,0,109),
(2,0,110),
(9,0,110),
(1,0,111),
(20,0,112),
(19,0,113),
(1,0,114),
(11,0,116),
(9,0,117),
(10,1,118),
(1,0,5000000000);
/*!40000 ALTER TABLE `pagelinks` ENABLE KEYS */;

-- Dump completed on 2026-01-01  0:00:00
