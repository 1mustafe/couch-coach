# CouchCoach — AI-Powered Real-Time Fitness Coaching

CouchCoach turns your phone camera into a real-time AI fitness coach. It uses pose estimation to track your body, counts reps via joint angle math, and provides AI-powered form feedback through Amazon Bedrock and voice coaching via Amazon Polly.

## Architecture

```
Phone Camera → TensorFlow.js MoveNet (browser) → Keypoints
                        ↓
                Rep counting (local math)
                Body position validation
                Mid-rep form checking
                        ↓
                Bad form? → Bedrock Haiku (keypoint analysis)
                        ↓
                Feedback → TV Dashboard (visual + Polly voice)
```

## Setup

```bash
# Install dependencies
npm install

# Start the server
node backend/server.js
```

Open:
- **TV Dashboard:** `http://localhost:3000/tv`
- **Phone App:** `http://localhost:3000/phone`

## Features

- Real-time pose tracking (17 keypoints at 30fps)
- Rep counting via joint angle math (no AI needed)
- Body orientation validation (prevents fake reps)
- Failed rep detection with depth feedback
- AI form analysis via Amazon Bedrock (Claude 3 Haiku)
- Voice coaching via Amazon Polly (Joanna Neural)
- 6-digit pairing code to connect phone ↔ TV
- Exercise support: Pushup, Squat, Lunge, Plank

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS, TensorFlow.js MoveNet
- **Backend:** Node.js (zero dependencies except AWS SDK)
- **AI:** Amazon Bedrock (Claude 3 Haiku) for form analysis
- **Voice:** Amazon Polly (Neural) for spoken coaching
- **Alexa+:** MagentaSDK Expert package (in `alexa-expert/`)

## Cost

- Good form reps: $0 (local processing only)
- Bad form reps: ~$0.0005 each (Bedrock Haiku)
- Voice feedback: ~$0.00004 per message (Polly)
- Typical 5-min workout: < $0.01
