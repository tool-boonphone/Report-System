CREATE TABLE `cached_customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`customer_id` varchar(64) NOT NULL,
	`customer_code` varchar(64),
	`full_name` varchar(255),
	`nationality` varchar(64),
	`id_document_no` varchar(32),
	`gender` varchar(16),
	`age_years` int,
	`occupation_title` varchar(512),
	`monthly_income` decimal(12,2),
	`workplace_name` varchar(1024),
	`mobile_phone` varchar(32),
	`idcard_district` varchar(128),
	`idcard_province` varchar(128),
	`current_district` varchar(128),
	`current_province` varchar(128),
	`work_district` varchar(128),
	`work_province` varchar(128),
	`synced_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cached_customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `cc_section_customer_idx` UNIQUE(`section`,`customer_id`)
);
--> statement-breakpoint
ALTER TABLE `debt_collected_cache` ADD `remark` text;--> statement-breakpoint
ALTER TABLE `sync_logs` ADD `resume_page` int DEFAULT 0;--> statement-breakpoint
CREATE INDEX `cc_section_idx` ON `cached_customers` (`section`);