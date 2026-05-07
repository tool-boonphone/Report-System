CREATE TABLE `debt_export_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(64) NOT NULL,
	`variant` enum('target','collected') NOT NULL,
	`storage_key` varchar(512) NOT NULL,
	`storage_url` varchar(512) NOT NULL,
	`row_count` int NOT NULL DEFAULT 0,
	`built_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `debt_export_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `dec_section_variant_idx` UNIQUE(`section`,`variant`)
);
