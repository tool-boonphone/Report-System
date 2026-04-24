ALTER TABLE `contracts` ADD `bad_debt_amount` decimal(12,2);--> statement-breakpoint
ALTER TABLE `contracts` ADD `bad_debt_date` varchar(20);--> statement-breakpoint
ALTER TABLE `contracts` ADD `suspended_from_period` int;