CREATE TABLE `app_group_permissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`group_id` int NOT NULL,
	`menu_code` varchar(64) NOT NULL,
	`can_view` boolean NOT NULL DEFAULT false,
	`can_add` boolean NOT NULL DEFAULT false,
	`can_edit` boolean NOT NULL DEFAULT false,
	`can_delete` boolean NOT NULL DEFAULT false,
	`can_approve` boolean NOT NULL DEFAULT false,
	`can_export` boolean NOT NULL DEFAULT false,
	CONSTRAINT `app_group_permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_group_perm_group_menu_idx` UNIQUE(`group_id`,`menu_code`)
);
--> statement-breakpoint
CREATE TABLE `app_groups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` varchar(255),
	`is_super_admin` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `app_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_groups_name_idx` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `app_sessions` (
	`id` varchar(64) NOT NULL,
	`user_id` int NOT NULL,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `app_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `app_users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`username` varchar(64) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`full_name` varchar(128),
	`email` varchar(255),
	`group_id` int NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`last_login_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `app_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_users_username_idx` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`external_id` varchar(64) NOT NULL,
	`contract_no` varchar(64) NOT NULL,
	`submit_date` varchar(20),
	`approve_date` varchar(20),
	`channel` varchar(64),
	`status` varchar(32),
	`partner_code` varchar(64),
	`partner_name` varchar(255),
	`partner_province` varchar(64),
	`partner_status` varchar(32),
	`commission_net` decimal(12,2),
	`customer_name` varchar(255),
	`nationality` varchar(64),
	`citizen_id` varchar(32),
	`gender` varchar(16),
	`age` int,
	`occupation` varchar(128),
	`salary` decimal(12,2),
	`workplace` varchar(255),
	`phone` varchar(32),
	`id_district` varchar(128),
	`id_province` varchar(128),
	`addr_district` varchar(128),
	`addr_province` varchar(128),
	`work_district` varchar(128),
	`work_province` varchar(128),
	`promotion_name` varchar(255),
	`device` varchar(64),
	`product_type` varchar(64),
	`model` varchar(128),
	`imei` varchar(64),
	`serial_no` varchar(64),
	`sell_price` decimal(12,2),
	`device_status` varchar(32),
	`down_payment` decimal(12,2),
	`finance_amount` decimal(12,2),
	`installment_count` int,
	`multiplier` decimal(6,2),
	`installment_amount` decimal(12,2),
	`payment_day` int,
	`paid_installments` int DEFAULT 0,
	`debt_type` varchar(32),
	`raw_json` json,
	`synced_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contracts_id` PRIMARY KEY(`id`),
	CONSTRAINT `contracts_section_external_idx` UNIQUE(`section`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `installments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`external_id` varchar(64) NOT NULL,
	`contract_external_id` varchar(64) NOT NULL,
	`contract_no` varchar(64),
	`period` int,
	`due_date` varchar(20),
	`amount` decimal(12,2),
	`paid_amount` decimal(12,2) DEFAULT '0',
	`status` varchar(32),
	`raw_json` json,
	`synced_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `installments_id` PRIMARY KEY(`id`),
	CONSTRAINT `installments_section_external_idx` UNIQUE(`section`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `payment_transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`external_id` varchar(64) NOT NULL,
	`contract_external_id` varchar(64),
	`contract_no` varchar(64),
	`customer_name` varchar(255),
	`paid_at` varchar(32),
	`amount` decimal(12,2),
	`method` varchar(64),
	`status` varchar(32),
	`raw_json` json,
	`synced_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payment_transactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_section_external_idx` UNIQUE(`section`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`section` varchar(32) NOT NULL,
	`entity` varchar(48) NOT NULL,
	`status` enum('in_progress','success','error') NOT NULL,
	`triggered_by` varchar(32) NOT NULL,
	`row_count` int DEFAULT 0,
	`error_message` text,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`finished_at` timestamp,
	CONSTRAINT `sync_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `app_sessions_user_idx` ON `app_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `app_users_group_idx` ON `app_users` (`group_id`);--> statement-breakpoint
CREATE INDEX `contracts_section_contract_no_idx` ON `contracts` (`section`,`contract_no`);--> statement-breakpoint
CREATE INDEX `contracts_section_customer_idx` ON `contracts` (`section`,`customer_name`);--> statement-breakpoint
CREATE INDEX `contracts_section_status_idx` ON `contracts` (`section`,`status`);--> statement-breakpoint
CREATE INDEX `contracts_section_approve_idx` ON `contracts` (`section`,`approve_date`);--> statement-breakpoint
CREATE INDEX `installments_section_contract_idx` ON `installments` (`section`,`contract_external_id`);--> statement-breakpoint
CREATE INDEX `installments_section_due_idx` ON `installments` (`section`,`due_date`);--> statement-breakpoint
CREATE INDEX `payments_section_contract_idx` ON `payment_transactions` (`section`,`contract_external_id`);--> statement-breakpoint
CREATE INDEX `payments_section_paid_at_idx` ON `payment_transactions` (`section`,`paid_at`);--> statement-breakpoint
CREATE INDEX `sync_logs_section_idx` ON `sync_logs` (`section`);--> statement-breakpoint
CREATE INDEX `sync_logs_finished_idx` ON `sync_logs` (`finished_at`);