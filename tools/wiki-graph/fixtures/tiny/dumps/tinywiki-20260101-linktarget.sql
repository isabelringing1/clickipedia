/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19  Distrib 10.11.18-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: fixture    Database: tinywiki
-- ------------------------------------------------------

/*!40101 SET NAMES utf8mb4 */;

--
-- Table structure for table `linktarget`
--

DROP TABLE IF EXISTS `linktarget`;
CREATE TABLE `linktarget` (
  `lt_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `lt_namespace` int(11) NOT NULL,
  `lt_title` varbinary(255) NOT NULL,
  PRIMARY KEY (`lt_id`),
  UNIQUE KEY `lt_namespace_title` (`lt_namespace`,`lt_title`)
) ENGINE=InnoDB AUTO_INCREMENT=5000000001 DEFAULT CHARSET=binary;

--
-- Dumping data for table `linktarget`
--

/*!40000 ALTER TABLE `linktarget` DISABLE KEYS */;
INSERT INTO `linktarget` VALUES
(106,-1,'Random'),
(109,0,'Back\\slash'),
(114,0,'Cafe'),
(107,0,'Café'),
(103,0,'Clicker'),
(101,0,'Cookie_Clicker'),
(117,0,'Dangling_redirect'),
(110,0,'Dead_end'),
(5000000000,0,'Huge_id_red_link'),
(102,0,'Idle_game'),
(104,0,'Incremental_game'),
(108,0,'It\'s_a_\"Quote\"'),
(111,0,'Loop_A'),
(105,0,'Nonexistent_page'),
(118,0,'Orphan'),
(116,0,'Section_redirect'),
(112,0,'Twin_A'),
(113,0,'Twin_B'),
(6,1,'Incremental_game'),
(15,10,'Infobox');
/*!40000 ALTER TABLE `linktarget` ENABLE KEYS */;

-- Dump completed on 2026-01-01  0:00:00
