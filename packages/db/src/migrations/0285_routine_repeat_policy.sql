-- A routine whose trigger condition can never become false re-dispatches forever.
-- The open-issue coalescing only sees issues in an open status, so a `done`
-- execution issue is invisible to it permanently, and dispatchFingerprint is only
-- used as a race guard between overlapping runs.

-- repeat_policy: null keeps today's behaviour exactly. 'skip_if_completed' lets a
-- routine treat a finished execution issue carrying the same dispatch fingerprint as
-- satisfying the trigger. repeat_window_seconds bounds that, and 0/null means opt-out
-- rather than "never fire".
--
-- Nullable with no default on purpose: existing rows stay untouched and no routine
-- changes behaviour until an owner opts in.
ALTER TABLE "routines" ADD COLUMN "repeat_policy" text;
ALTER TABLE "routines" ADD COLUMN "repeat_window_seconds" integer;
