
-- This script takes one key (our inventory key)
local key = KEYS[1]

-- Get the current value
local current_stock = tonumber(redis.call('GET', key))

--  Check if stock exists and is greater than 0
if current_stock and current_stock > 0 then
  -- If yes, decrement it and return the new value
  return redis.call('DECR', key)
else
  -- If no, return -1 to signal it's out of stock
  return -1
end 