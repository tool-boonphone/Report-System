ALTER TABLE `payment_transactions` ADD `income_type` varchar(32);--> statement-breakpoint
CREATE INDEX `payments_section_income_type_idx` ON `payment_transactions` (`section`,`income_type`);
