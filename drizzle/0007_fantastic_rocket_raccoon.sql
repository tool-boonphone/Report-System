CREATE TABLE `debt_collected_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`contract_external_id` varchar(64) NOT NULL,
	`contract_no` varchar(64) NOT NULL,
	`customer_name` varchar(255),
	`approve_date` varchar(20),
	`contract_status` varchar(32),
	`partner_code` varchar(255),
	`partner_name` varchar(255),
	`product_type` varchar(64),
	`device` varchar(64),
	`model` varchar(128),
	`finance_amount` decimal(12,2),
	`installment_count` int,
	`payment_external_id` varchar(64) NOT NULL,
	`period` int,
	`paid_at` varchar(32),
	`principal` decimal(12,2) NOT NULL DEFAULT '0',
	`interest` decimal(12,2) NOT NULL DEFAULT '0',
	`fee` decimal(12,2) NOT NULL DEFAULT '0',
	`penalty` decimal(12,2) NOT NULL DEFAULT '0',
	`unlock_fee` decimal(12,2) NOT NULL DEFAULT '0',
	`discount` decimal(12,2) NOT NULL DEFAULT '0',
	`overpaid` decimal(12,2) NOT NULL DEFAULT '0',
	`bad_debt` decimal(12,2) NOT NULL DEFAULT '0',
	`total_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`updated_by` varchar(128),
	`is_bad_debt_row` boolean NOT NULL DEFAULT false,
	`populated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `debt_collected_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `dcc_section_payment_idx` UNIQUE(`section`,`payment_external_id`)
);
--> statement-breakpoint
CREATE TABLE `debt_target_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`contract_external_id` varchar(64) NOT NULL,
	`contract_no` varchar(64) NOT NULL,
	`customer_name` varchar(255),
	`approve_date` varchar(20),
	`contract_status` varchar(32),
	`partner_code` varchar(255),
	`partner_name` varchar(255),
	`product_type` varchar(64),
	`device` varchar(64),
	`model` varchar(128),
	`finance_amount` decimal(12,2),
	`installment_count` int,
	`period` int NOT NULL,
	`due_date` varchar(20),
	`principal` decimal(12,2) NOT NULL DEFAULT '0',
	`interest` decimal(12,2) NOT NULL DEFAULT '0',
	`fee` decimal(12,2) NOT NULL DEFAULT '0',
	`penalty` decimal(12,2) NOT NULL DEFAULT '0',
	`unlock_fee` decimal(12,2) NOT NULL DEFAULT '0',
	`net_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`total_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`paid_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`overpaid_applied` decimal(12,2) NOT NULL DEFAULT '0',
	`baseline_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`is_paid` boolean NOT NULL DEFAULT false,
	`is_partial_paid` boolean NOT NULL DEFAULT false,
	`is_closed` boolean NOT NULL DEFAULT false,
	`is_suspended` boolean NOT NULL DEFAULT false,
	`is_current_period` boolean NOT NULL DEFAULT false,
	`is_future_period` boolean NOT NULL DEFAULT false,
	`is_arrears` boolean NOT NULL DEFAULT false,
	`is_bad_debt` boolean NOT NULL DEFAULT false,
	`debt_range` varchar(32),
	`populated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `debt_target_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `dtc_section_contract_period_idx` UNIQUE(`section`,`contract_external_id`,`period`)
);
--> statement-breakpoint
CREATE INDEX `dcc_section_contract_idx` ON `debt_collected_cache` (`section`,`contract_external_id`);--> statement-breakpoint
CREATE INDEX `dcc_section_paid_at_idx` ON `debt_collected_cache` (`section`,`paid_at`);--> statement-breakpoint
CREATE INDEX `dcc_section_approve_date_idx` ON `debt_collected_cache` (`section`,`approve_date`);--> statement-breakpoint
CREATE INDEX `dcc_section_product_type_idx` ON `debt_collected_cache` (`section`,`product_type`);--> statement-breakpoint
CREATE INDEX `dcc_section_updated_by_idx` ON `debt_collected_cache` (`section`,`updated_by`);--> statement-breakpoint
CREATE INDEX `dtc_section_due_date_idx` ON `debt_target_cache` (`section`,`due_date`);--> statement-breakpoint
CREATE INDEX `dtc_section_approve_date_idx` ON `debt_target_cache` (`section`,`approve_date`);--> statement-breakpoint
CREATE INDEX `dtc_section_status_idx` ON `debt_target_cache` (`section`,`contract_status`);--> statement-breakpoint
CREATE INDEX `dtc_section_debt_range_idx` ON `debt_target_cache` (`section`,`debt_range`);--> statement-breakpoint
CREATE INDEX `dtc_section_product_type_idx` ON `debt_target_cache` (`section`,`product_type`);