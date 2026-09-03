# HillsByte

Mobile-first earning/CPA platform starter designed for a Telegram Mini App.

## Features
- Telegram WebApp user detection
- Browser demo account fallback
- User profile and email field
- Separate USD balance and HillsCoin wallet
- Referral code/link
- Task listing and server-side completion state
- Withdrawal requests
- BEP20-compatible payment address field
- Transaction history
- Simple admin dashboard/API
- SQLite database

## Run
Install Node.js 20+, then:

    cp .env.example .env
    npm install
    npm start

Open http://localhost:3000
Admin: http://localhost:3000/admin.html

## Important
This is a working starter, not a live CPA/payment integration. Before production, add verified Telegram initData validation, real CPA provider postbacks, fraud controls, rate limiting, secure admin authentication, production database, and a real payout processor.

Never ask users for seed phrases or private keys. Keep TELEGRAM_BOT_TOKEN server-side in .env.
