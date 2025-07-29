import fetch from "node-fetch";
async function simulateConcurrentReservations() {
  const promises = [];
  for (let i = 0; i < 7; i++) {
    promises.push(
      fetch("http://localhost:3000/product/22/reserve", { method: "POST" })
    );
  }
  await Promise.all(promises);
  console.log("Done");
}

simulateConcurrentReservations().catch(console.error);
