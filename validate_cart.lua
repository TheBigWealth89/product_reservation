local cartKey = KEYS[1]
local userId = ARGV[1]
local cartItems = redis.call('SMEMBERS', cartKey)
local validItems = {}
local expiredItems = {}

for i, cartItem in ipairs(cartItems) do
    local productId, reservationId = string.match(cartItem, "^(%d+):rev%-([%w%-]+)$")
    if productId and reservationId then
        local reservationKey = 'reservation:product:' .. productId .. ':user-' .. userId .. ':rev-' .. reservationId
        
        -- This is a read-only check.
        local keyExists = redis.call('EXISTS', reservationKey)
        
        if keyExists == 1 then
            table.insert(validItems, cartItem)
        else
            table.insert(expiredItems, cartItem)
        end
    end
end

return {validItems, expiredItems}