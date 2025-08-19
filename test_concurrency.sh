
HOST="http://localhost:3000"
PRODUCT_ID="1"
USER_A="user-A"
USER_B_FAIL="failing-user"
USER_C="user-C"

echo "--- Preparing Reservations ---"
# Reserve one item for each user
curl -X POST -H "x-user-id: $USER_A" "$HOST/product/$PRODUCT_ID/reserve"
echo ""
curl -X POST -H "x-user-id: $USER_B_FAIL" "$HOST/product/$PRODUCT_ID/reserve"
echo ""
curl -X POST -H "x-user-id: $USER_C" "$HOST/product/$PRODUCT_ID/reserve"
echo ""

echo "--- All reservations placed. Waiting 1 second... ---"
sleep 1

echo "--- Triggering Concurrent Purchases ---"
# The '&' at the end runs the command in the background,
# allowing all three to start at nearly the same time.
curl -X POST -H "x-user-id: $USER_A" "$HOST/product/$PRODUCT_ID/purchase" &
curl -X POST -H "x-user-id: $USER_B_FAIL" "$HOST/product/$PRODUCT_ID/purchase" &
curl -X POST -H "x-user-id: $USER_C" "$HOST/product/$PRODUCT_ID/purchase" &

echo "--- All purchase requests sent. Check your worker logs. ---"
wait