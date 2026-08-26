-- DIV-016 part B: the owner-approved "override-as-bridge" precedence
-- (TASKS.md DIV-016) needs an explicit per-security escape hatch to force
-- an owner override to keep winning once 12+ months of real dividend
-- history would otherwise supersede it automatically. A plain `ALTER TABLE
-- ... ADD COLUMN` (no CHECK, no FK, no rebuild) -- FY-001A-safe per the
-- 0053-0056 precedent; nullable, defaulting to NULL/false ("not forced")
-- so every pre-existing row is unaffected and the bridge default-off
-- behaviour (history wins automatically once 12 months of evidence exists)
-- applies to every row that has never explicitly set this flag.
ALTER TABLE `dividend_security_assumptions` ADD `force_assumption` integer;
