# Full-Stack E-Commerce Reservation & Payment System

A production-grade, fault-tolerant system built with Node.js, PostgreSQL, Redis, and BullMQ. This project demonstrates how to build a decoupled, resilient architecture that handles high-concurrency reservations, processes secure payments with Stripe, and delivers real-time updates to the user.

![Project Status](https://img.shields.io/badge/status-complete-brightgreen)
![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## The Problem: Building a System That Can't Fail

In any high-traffic e-commerce application, a naive approach will fail. This project is engineered to solve four critical, real-world problems:

1.  **Race Conditions:** Prevents multiple users from buying the last item at the same time, which leads to overselling and data corruption.
2.  **System Failures:** Guarantees that no purchase is ever lost, even if the database crashes or the server restarts during an order.
3.  **Abandoned Carts:** Automatically returns stock from reservations that are not completed within a specific time window.
4.  **Stale User Interfaces:** Ensures every user sees a live, accurate inventory count that updates in real-time without needing to refresh the page.

---

## The Architecture: A Decoupled, Real-Time Design

This system uses a modern, multi-service architecture to achieve high performance, fault tolerance, and a dynamic user experience.

![Architecture Diagram](https://raw.githubusercontent.com/TheBigWealth89/product_reservation/main/src/assets/reservation_diagram.drawi.png)

### System Workflow

The application operates through two primary flows: the **Order Flow** and the **Real-Time Update Flow**.
1.  A **User** sends an HTTP request (e.g., to reserve or pay) to the **API Server**.
2.  The **API Server** uses **Redis** for fast, atomic operations (Lua scripts) and to add jobs to the **BullMQ** queue.
3.  For payments, the **API Server** communicates with the external **Stripe** service.
4.  The **API Server** also uses Redis Pub/Sub to listen for updates from the workers. When it gets an update, it sends a message via **Socket.IO** back to the user.
5.  The **Background Workers** pull jobs from the **Redis** queue.
6.  The **Workers** do the heavy lifting, interacting with the main **PostgreSQL** database. They also `PUBLISH` messages to Redis when they're done.
7.  **Stripe** sends asynchronous **Webhooks** back to a special endpoint on the **API Server** to confirm payments.

---

### Architectural Components

- **API Server (Express.js):** A lightweight web service that handles incoming requests and acts as a **Real-Time Broadcaster**, using Socket.IO to push live updates to connected clients.
- **Redis (The Gatekeeper):** Acts as a high-speed in-memory store for four critical tasks:
  1.  **Atomic Operations:** Lua scripts ensure inventory checks are race-condition-proof.
  2.  **Job Queue (BullMQ):** Reliably queues order fulfillment jobs for background processing.
  3.  **Pub/Sub Messaging:** Serves as a high-speed message bus between workers and the API server for real-time updates.
  4.  **Session & Cart Storage:** Provides a fast cache for user data.
- **PostgreSQL (The Source of Truth):** The permanent, relational database that stores all product, inventory, and order data with transactional integrity.
- **Stripe Integration:** Securely handles all sensitive payment information off-site, communicating with the backend via verified webhooks to confirm transactions.
- **Background Workers:** Independent Node.js processes that handle specific, long-running tasks (order fulfillment, reservation expiration, cleanup worker), allowing the system to scale and remain resilient.

---

## ✨ Key Features

- **Real-Time Inventory Updates:** Uses **WebSockets (Socket.IO)** and Redis Pub/Sub to instantly update the inventory count on every user's screen the moment a reservation is made, expires, or is purchased.
- **Secure Payment Processing:** Integrates **Stripe** for payments, using Payment Intents and secure webhook verification to handle financial transactions safely.
- **Atomic Reservations:** Uses Redis Lua scripting to make inventory checks and decrements an uninterruptible, all-or-nothing operation.
- **Decoupled & Fault-Tolerant:** Uses **BullMQ** to process order fulfillment in the background. If the database is down, the job is automatically retried without being lost.
- **Idempotent Workers:** The fulfillment worker is designed to be safely retried. It will never decrement stock twice for the same order, guaranteeing data consistency.
- **Self-Healing Cleanup:** A polling-based background worker reliably finds and cancels expired reservations, returning stock to inventory.
- **Admin Dashboard:** A web interface for monitoring failed jobs and allowing an administrator to manually retry or cancel a stuck purchase.

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js
- **Payments:** Stripe
- **Real-Time:** Socket.IO
- **Primary Database:** PostgreSQL
- **In-Memory Store:** Redis (with **`ioredis`**)
- **Job Queue:** BullMQ
- **Scheduling:** `node-cron`
- **Load Testing:** `bash` scripting with `curl`

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v20+)
- PostgreSQL
- Redis
- A free Stripe developer account

### Setup & Installation

1.  **Clone the repository:**

    ```bash
    git clone [https://github.com/TheBigWealth89/product_reservation.git](https://github.com/TheBigWealth89/product_reservation.git)
    cd product_reservation
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Set up Environment Variables:**

    - Create a `.env` file in the root of the project.
    - Copy the contents of `.env.example` into your new `.env` file.
    - Fill in your PostgreSQL, Redis, and **Stripe API keys**.

4.  **Set up the database:**
    - Create a PostgreSQL database with the name you specified in your `.env` file.
    - Run the schema scripts in the `sql` directory to create the `products` and `orders` tables.

---

## 🏃 Running the Application

This is a multi-service application. Each component must be run in a separate terminal for development.

### For Development

- **Terminal 1 (Main API & Web Server):** `npm run dev`
- **Terminal 2 (Purchase Fulfillment Worker):** `npm run dev:fulfillOrderWorker`
- **Terminal 3 (Reservation Expiration Worker):** `npm run dev:expiresWorker`
- **Terminal 4 (Failed Job Cleanup Worker):** `npm run dev:cleanupWorker`

### For Production

- **Terminal 1:** `npm run start`
- **Terminal 2:** `npm run start:purchaseWorker`
- **Terminal 3:** `npm run start:expiresWorker`
- **Terminal 4:** `npm run start:cleanupWorker`

---

## 🧪 Load Testing for Concurrency

To simulate a high-traffic event and verify that the race condition is solved, you can use the provided concurrency test script.

1.  Make sure your application services are running.
2.  Run the script from your terminal:
    ```bash
    # On macOS/Linux or Git Bash on Windows
    bash test_concurrency.sh
    ```
3.  This script will first create several reservations and then fire off all the purchase requests at the same time. Check your worker logs to observe how the jobs are processed concurrently and gracefully.
