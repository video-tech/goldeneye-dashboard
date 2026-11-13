-- "Book your setup call" ticks itself from a real booking (2026-11-12). Turns off the step's "I've booked my call" button
-- (requires_confirm), so the portal treats it like a form that ticks itself: no client tick, a "Booked but it didn't tick?
-- Let us know" link, and it is completed by supabase/functions/onboarding-booking when our Midas GHL reports the booking.
-- Admins can still tick or untick it by hand. Applies to any active client step embedding a GHL booking widget.
-- Deploy onboarding-booking and set up the GHL workflow first, or bookings made in between won't tick it. Safe to re-run.
update public.onboarding_steps
   set requires_confirm = false, confirm_label = null
 where owner = 'client' and step_type = 'form' and embed_url ~* '/widget/(booking|bookings|appointment)s?/';
