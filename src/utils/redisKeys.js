export const redisKey = {
  cartKey: (userId) => `cart:user-${userId}`,
  inventoryKey: (id) => `inventory:product-${id}`,
  cartEntry: (id, reservationId) => `${id}:rev-${reservationId}`,
  reservationKey: (id, userId, reservationId) =>
    `reservation:product:${id}:user-${userId}:rev-${reservationId}`,
};
