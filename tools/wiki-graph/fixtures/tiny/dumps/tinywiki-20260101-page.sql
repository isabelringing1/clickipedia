/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19  Distrib 10.11.18-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: fixture    Database: tinywiki
-- ------------------------------------------------------
-- Server version	10.11.13-MariaDB-log

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET TIME_ZONE='+00:00' */;

--
-- Table structure for table `page`
--

DROP TABLE IF EXISTS `page`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `page` (
  `page_id` int(8) unsigned NOT NULL AUTO_INCREMENT,
  `page_namespace` int(11) NOT NULL DEFAULT 0,
  `page_title` varbinary(255) NOT NULL DEFAULT '',
  `page_is_redirect` tinyint(1) unsigned NOT NULL DEFAULT 0,
  `page_is_new` tinyint(1) unsigned NOT NULL DEFAULT 0,
  `page_random` double unsigned NOT NULL DEFAULT 0,
  `page_touched` binary(14) NOT NULL,
  `page_links_updated` binary(14) DEFAULT NULL,
  `page_latest` int(8) unsigned NOT NULL DEFAULT 0,
  `page_len` int(8) unsigned NOT NULL DEFAULT 0,
  `page_content_model` varbinary(32) DEFAULT NULL,
  `page_lang` varbinary(35) DEFAULT NULL,
  PRIMARY KEY (`page_id`),
  UNIQUE KEY `page_name_title` (`page_namespace`,`page_title`),
  KEY `page_random` (`page_random`),
  KEY `page_len` (`page_len`),
  KEY `page_redirect_namespace_len` (`page_is_redirect`,`page_namespace`,`page_len`)
) ENGINE=InnoDB AUTO_INCREMENT=25 DEFAULT CHARSET=binary ROW_FORMAT=COMPRESSED;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `page`
--

/*!40000 ALTER TABLE `page` DISABLE KEYS */;
INSERT INTO `page` VALUES
(1,0,'Incremental_game',0,0,0.856935107283,'20260101000000','20260101000000',1001,5120,'wikitext',NULL),
(2,0,'Cookie_Clicker',0,0,0.870480291199,'20260101000000','20260101000000',1002,4096,'wikitext',NULL),
(3,0,'Idle_game',1,0,0.13895768761,'20260101000000','20260101000000',1003,32,'wikitext',NULL),
(4,0,'Clicker',1,0,0.442158983637,'20260101000000','20260101000000',1004,28,'wikitext',NULL),
(5,0,'Loop_A',1,0,0.426142143813,'20260101000000','20260101000000',1005,24,'wikitext',NULL),
(6,0,'Loop_B',1,0,0.57066921872,'20260101000000','20260101000000',1006,24,'wikitext',NULL),
(7,0,'It\'s_a_\"Quote\"',0,0,0.674272520164282,'20260101000000','20260101000000',1007,640,'wikitext',NULL),
(8,0,'Back\\slash',0,0,0.676683114602,'20260101000000','20260101000000',1008,512,'wikitext',NULL),
(9,0,'Café',0,0,0.123456789,'20260101000000','20260101000000',1009,300,'wikitext',NULL),
(10,1,'Incremental_game',0,0,0.5,'20260101000000','20260101000000',1010,900,'wikitext',NULL);
INSERT INTO `page` VALUES
(11,0,'Orphan',0,1,0.25,'20260101000000',NULL,1011,200,'wikitext',NULL),
(12,0,'Island',0,1,0.75,'20260101000000',NULL,1012,100,'wikitext',NULL),
(13,0,'Dangling_redirect',1,0,0.31,'20260101000000','20260101000000',1013,30,'wikitext',NULL),
(14,0,'To_talk',1,0,0.32,'20260101000000','20260101000000',1014,30,'wikitext',NULL),
(15,0,'Interwiki_redirect',1,0,0.33,'20260101000000','20260101000000',1015,30,'wikitext',NULL),
(16,0,'Dead_end',0,0,0.34,'20260101000000','20260101000000',1016,80,'wikitext',NULL),
(17,14,'Games',0,0,0.35,'20260101000000','20260101000000',1017,60,'wikitext',NULL),
(18,0,'Self_redirect',1,0,0.36,'20260101000000','20260101000000',1018,30,'wikitext',NULL),
(19,0,'Twin_A',0,0,0.37,'20260101000000','20260101000000',1019,70,'wikitext',NULL),
(20,0,'Twin_B',0,0,0.38,'20260101000000','20260101000000',1020,70,'wikitext',NULL),
(21,0,'Broken_redirect_flag',1,0,0.39,'20260101000000','20260101000000',1021,10,'wikitext',NULL),
(22,0,'Cafe',1,0,0.4,'20260101000000','20260101000000',1022,20,'wikitext',NULL),
(23,0,'Section_redirect',1,0,0.41,'20260101000000','20260101000000',1023,40,'wikitext',NULL),
(24,10,'Infobox',0,0,0.42,'20260101000000','20260101000000',1024,999,'wikitext',NULL);
/*!40000 ALTER TABLE `page` ENABLE KEYS */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

-- Dump completed on 2026-01-01  0:00:00
