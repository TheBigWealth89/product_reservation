-- Key for the user's cart 
local cartKey = KEYS[1]
-- The user ID, needed to build reservation keys
local userId = ARGV[1]

-- Get all items from the user's cart set
local cartItems = redis.call('SMEMBERS', cartKey)
local successfulPurchases = {}
local failedPurchases = {}

-- Helper function to log both to Redis and to the debug log array


-- Loop through each item in the cart
for i, cartItem in ipairs(cartItems) do

    -- Parse the productId and reservationId from the cart item string
   local productId, reservationId = string.match(cartItem, "^(%d+):rev%-([%w%-]+)$")

    if productId and reservationId then
        -- Construct the full reservation key
        local reservationKey = 'reservation:product:' .. productId .. ':user-' .. userId .. ':rev-' .. reservationId

        -- Atomically check and delete the reservation key
        local keysDeleted = redis.call('DEL', reservationKey)

        if keysDeleted > 0 then
            table.insert(successfulPurchases, cartItem)
            redis.call('srem', cartKey, cartItem)
        else
            table.insert(failedPurchases, cartItem)
            redis.call('srem', cartKey, cartItem)
        end
    end
end

-- Return the two lists of successful and failed items, plus logs
return {successfulPurchases, failedPurchases}
    