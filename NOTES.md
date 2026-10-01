# Sneaker Drop Assignment - Notes

## Stack

- Node.js
- Express
- Redis
- Plain HTML/CSS/JavaScript

## Requirements

- Node.js 20+
- Redis
- npm

## Run the project

### 1. Start Redis

On macOS with Homebrew:

```bash
brew services start redis
```

Verify Redis:

```bash
redis-cli ping
```

Expected:

```text
PONG
```

### 2. Install dependencies

```bash
cd server
npm install
```

### 3. Start the server

```bash
npm run dev
```

The server and demo page run at:

```text
http://localhost:5050
```

## API

### Get stock

`GET /stock`

### Buy / hold

`POST /buy`

```json
{
  "userId": "user1"
}
```

Creates a 5-minute hold and returns a unique `holdId`.

### Pay

`POST /pay`

```json
{
  "userId": "user1",
  "holdId": "<holdId returned by /buy>"
}
```

The `holdId` prevents an old or out-of-order payment notification from paying for a newer hold belonging to the same user.

### Join waiting queue

`POST /join-queue`

```json
{
  "userId": "user2"
}
```

A user can join only when stock is sold out, unless they are already in the queue.

### Get user status

`GET /status/user1`

Returns the current status, purchased count, queue position, and active `holdId` when applicable.

### Fake payment provider

`POST /fake-payment`

```json
{
  "userId": "user1",
  "holdId": "<holdId returned by /buy>",
  "delayMs": 2000,
  "duplicate": true
}
```

This simulates delayed and duplicate payment notifications.

## Redis data

Redis is used for the high-contention sale state:

- `sneaker:stock` - available pairs
- `hold:<userId>` - temporary hold containing the unique `holdId`
- `sneaker:holds` - sorted set used for hold expiration tracking
- `sneaker:queue` - FIFO waiting queue
- `purchased:<userId>` - completed purchase count
- `payment:<holdId>` - short-lived idempotency marker for completed payment notifications

## Rules implemented

- 20 pairs initially available.
- A user can hold only one pair at a time.
- A hold lasts 5 minutes.
- A user can purchase at most 2 pairs.
- Stock reservation and user eligibility checks happen atomically in Redis Lua scripts.
- A user already waiting in the queue cannot bypass the queue with a direct buy.
- Users can join the queue only when stock is sold out.
- Expired holds are returned to stock when nobody is waiting.
- When users are waiting, the first eligible user in the FIFO queue receives the released pair.
- Queue users who have reached the purchase limit or already have a hold are skipped safely.
- Payment is tied to a unique `holdId`, so a late payment for an expired hold cannot pay for a newer hold.
- Duplicate payment notifications do not create another purchase.
- Payment and hold-expiration operations are atomic, so whichever event reaches Redis first determines the result safely.

## Reset local Redis data

For a clean local test:

```bash
redis-cli FLUSHDB
```

Restart the server after resetting the database.

## Concurrency notes

The critical sale operations are performed with Redis Lua scripts. This keeps validation and inventory changes in one atomic operation and prevents two simultaneous requests from both passing the same stock/user checks.
