ALTER TABLE `sync_logs` ADD `current_stage` varchar(32);--> statement-breakpoint
ALTER TABLE `sync_logs` ADD `progress` int DEFAULT 0;