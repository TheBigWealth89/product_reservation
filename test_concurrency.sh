
# --- Configuration ---
HOST="http://localhost:3000"
PRODUCT_ID="1" # The ID of the product you want to test
USERS=("user-A" "user-B" "user-C" "user-D" "user-E" "user-F") # Simulate 6 different users

# --- Main Test Logic ---
echo "--- 🚀 Starting High-Concurrency Reservation Test ---"
echo "This script will attempt to reserve Product ID: $PRODUCT_ID for ${#USERS[@]} different users at the same time."
echo "Check your server logs for the 'New inventory' count."
echo ""

# Fire off all reservation requests in the background concurrently
for user in "${USERS[@]}"; do
    echo "Sending reservation request for $user..."
    curl -s -X POST -H "x-user-id: $user" "$HOST/product/$PRODUCT_ID/reserve" > /dev/null &
done

echo ""
echo "--- All requests sent. Waiting for them to complete... ---"
# The 'wait' command ensures the script doesn't exit until all background curl jobs are finished
wait

echo ""
echo "--- ✅ Test Complete. ---"
echo "Check your database and Redis to confirm the final inventory count is correct."