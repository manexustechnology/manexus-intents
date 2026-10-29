-- JSON {standard, payload, deadline, meta} of the 1Click-generated intent the owner must sign.
-- submitWithdrawal relays only a signature over exactly this payload.
ALTER TABLE withdrawals ADD COLUMN intent TEXT;
