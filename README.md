# High-Concurrency Inventory Reservation System

A production-grade, fault-tolerant system built with Node.js, PostgreSQL, Redis, and BullMQ to solve the "race condition" problem found in high-traffic e-commerce and booking platforms.

This project demonstrates how to build a decoupled, resilient architecture that prevents overselling, handles system failures gracefully, and ensures every order is processed reliably.

![Project Status](https://img.shields.io/badge/status-complete-brightgreen)
![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## The Problem: Race Conditions & System Failures

In any system with limited stock (like concert tickets or flash sale items), a naive approach will fail under concurrent load. This project solves three critical problems:

1.  **Race Conditions:** Prevents multiple users from buying the last item at the same time, which leads to overselling and data corruption.
2.  **System Failures:** Guarantees that no purchase is ever lost, even if the database crashes or the server restarts during an order.
3.  **Abandoned Carts:** Automatically returns stock from reservations that are not completed within a specific time window.

---
## The Architecture: A Decoupled, Resilient Design

This system uses a modern, multi-service architecture to achieve high performance and fault tolerance.

![Architecture Diagram](https://raw.githubusercontent.com/TheBigWealth89/product_reservation/main/src/assets/reservation_diagram.drawio.png)

* **API Server (Express.js):** A lightweight web service that handles incoming requests. It offloads all slow database work to the job queue, allowing it to respond to the user in milliseconds.
* **Redis (The Gatekeeper):** Acts as a high-speed in-memory store for three critical tasks:
    1.  **Atomic Operations:** Lua scripts ensure inventory checks are race-condition-proof.
    2.  **Job Queue (BullMQ):** Reliably queues purchase requests for background processing.
    3.  **Session & Cart Storage:** Provides a fast cache for user data.
* **PostgreSQL (The Source of Truth):** The permanent, relational database that stores all product, inventory, and reservation data with transactional integrity.
* **Background Workers:** Independent Node.js processes that handle specific tasks, allowing the system to scale and remain resilient. A failure in one worker does not affect the others or the main API.

---

## ✨ Key Features

-   **Atomic Reservations:** Uses Redis Lua scripting to make inventory checks and decrements an uninterruptible, all-or-nothing operation.
-   **Decoupled & Fault-Tolerant:** Uses **BullMQ** to process purchases in the background. If the database is down, the job is automatically retried without being lost.
-   **Idempotent Workers:** The purchase worker is designed to be safely retried. It will never decrement stock twice for the same order, guaranteeing data consistency.
-   **Self-Healing Cleanup:** A polling-based background worker reliably finds and cancels expired reservations, returning stock to inventory.
-   **Admin Dashboard:** A web interface for monitoring failed jobs and allowing an administrator to manually retry or cancel a stuck purchase.
-   **Polyglot Architecture:** Demonstrates the professional pattern of using the right tool for the right job (PostgreSQL for integrity, Redis for speed).

---

## 🛠️ Tech Stack

-   **Backend:** Node.js, Express.js
-   **Primary Database:** PostgreSQL
-   **In-Memory Store:** Redis (with **`ioredis`**)
-   **Job Queue:** BullMQ
-   **Scheduling:** `node-cron`
-   **Load Testing:** `bash` scripting with `curl`

---

## 🚀 Getting Started

### Prerequisites

-   Node.js (v20+)
-   PostgreSQL
-   Redis

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
    -   Create a `.env` file in the root of the project.
    -   Copy the contents of `.env.example` into your new `.env` file.
    -   Fill in your PostgreSQL and Redis connection details.

4.  **Set up the database:**
    -   Create a PostgreSQL database with the name you specified in your `.env` file.
    -   Run the schema scripts in the `sql` directory to create the necessary tables.

---

## 🏃 Running the Application

This is a multi-service application. Each component must be run in a separate terminal.

### For Development (with auto-reloading)

-   **Terminal 1 (Main API Server):**
    ```bash
    npm run dev
    ```
-   **Terminal 2 (Purchase Worker):**
    ```bash
    npm run dev:purchaseWorker
    ```
-   **Terminal 3 (Expires Worker):**
    ```bash
    npm run dev:expiresWorker
    ```
-   **Terminal 4 (Failed Job Cleanup Worker):**
    ```bash
    npm run dev:cleanupWorker
    ```

### For Production

-   **Terminal 1 (Main API Server):** `npm run start`
-   **Terminal 2 (Purchase Worker):** `npm run start:purchaseWorker`
-   **Terminal 3 (Expires Worker):** `npm run start:expiresWorker`
-   **Terminal 4 (Failed Job Cleanup Worker):** `npm run start:cleanupWorker`

---

## 🧪 Load Testing for Concurrency

To simulate a high-traffic event and verify that the race condition is solved, you can use the provided concurrency test script.

1.  Make sure your application services are running.
2.  Run the script from your terminal:
    ```bash
    # On macOS/Linux or Git Bash on Windows
    bash test_concurrency.sh
    ```
3.  This script will first create several reservations for different users and then fire off all the purchase requests at the same time. Check your worker logs to observe how the jobs are processed concurrently and gracefully.