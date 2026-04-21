const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const polly = new PollyClient({ region: 'us-east-1' });

const sessions = new Map();

function genCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function json(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data));
}

function serveFile(res, filePath, contentType) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

function parseBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => { chunks.push(c); size += c.length; if (size > 10e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { resolve({}); }
        });
    });
}

// Keypoint-based form analysis via Bedrock Haiku (fast + cheap)
async function analyzeKeypoints(exercise, keypointData) {
    if (!keypointData) {
        return { text: 'Position yourself in frame', score: 'warning' };
    }

    try {
        const prompt = `You are a fitness coach. Analyze this ${exercise} rep from body keypoint data.

DATA:
${JSON.stringify(keypointData)}

The data contains joint angles and keypoint positions captured at the top and bottom of one rep.
- angles: key joint angles in degrees
- positions: normalized x,y coordinates (0-1) of body landmarks

Respond with EXACTLY this JSON, nothing else:
{"text":"<spoken feedback in 10 words or less>","score":"<good|warning|bad>"}

Rules for the text field:
- Write as if you are speaking directly to the person mid-workout
- No emojis, no special characters, no exclamation marks
- No stage directions like *chuckles* or *clears throat* or any text in asterisks
- Just plain spoken words, nothing else
- Sound like a calm, encouraging personal trainer
- Examples: "Nice depth, now push those knees out", "Tighten your core, hips are dropping a bit"

Scoring rules for ${exercise}:
${getExerciseRules(exercise)}

Be specific about what body part needs adjustment. Be encouraging on good form.`;

        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 60,
            messages: [{ role: 'user', content: prompt }]
        });

        const cmd = new InvokeModelCommand({
            modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
            contentType: 'application/json',
            body: body,
        });

        const resp = await bedrock.send(cmd);
        const result = JSON.parse(new TextDecoder().decode(resp.body));
        const text = result.content[0].text.trim();

        try {
            const parsed = JSON.parse(text);
            if (parsed.text && parsed.score) return parsed;
        } catch { /* fall through */ }

        return { text: text.slice(0, 60), score: 'warning' };
    } catch (e) {
        console.error('Bedrock error:', e.message);
        return { text: 'Keep going — analyzing form', score: 'warning' };
    }
}

function getExerciseRules(exercise) {
    const rules = {
        pushup: `- good: elbow angle reaches 70-100° at bottom, hip angle stays 160-180° (straight body)
- warning: elbow doesn't go below 110° (not deep enough) OR hip angle 140-160° (slight sag)
- bad: hip angle below 140° (major sag) OR elbows flaring past 90° from body`,
        squat: `- good: knee angle reaches 70-100° at bottom, hip angle 70-100°, torso stays upright
- warning: knee angle only reaches 100-120° (not deep enough) OR knees tracking inward
- bad: knees caving significantly OR torso leaning forward excessively (hip angle mismatch)`,
        plank: `- good: hip angle 165-180° (straight line), shoulder-hip-ankle aligned
- warning: hip angle 150-165° (slight sag or pike)
- bad: hip angle below 150° (major sag) or above 190° (piking up)`,
        lunge: `- good: front knee angle 80-100° at bottom, back knee near floor
- warning: front knee angle only 100-120° (not deep enough)
- bad: front knee pushing past toes significantly OR torso leaning forward`,
    };
    return rules[exercise] || rules.pushup;
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // ── Serve apps ──
    if (p === '/tv' || p === '/tv/') {
        return serveFile(res, path.join(__dirname, '..', 'tv-dashboard', 'index.html'), 'text/html');
    }
    if (p === '/phone' || p === '/phone/') {
        return serveFile(res, path.join(__dirname, '..', 'phone-app', 'index.html'), 'text/html');
    }
    if (p === '/workouts.json') {
        return serveFile(res, path.join(__dirname, '..', 'workouts.json'), 'application/json');
    }

    // ── API ──

    // POST /api/session/create
    if (p === '/api/session/create' && req.method === 'POST') {
        const code = genCode();
        const id = crypto.randomUUID();
        sessions.set(code, {
            id, code, paired: false, active: false,
            exercise: 'pushup', reps: 0, formScore: null,
            feedback: [], lastAnalysis: null, elapsedStart: null,
        });
        // Auto-expire after 2 hours
        setTimeout(() => sessions.delete(code), 7200000);
        return json(res, 200, { code, sessionId: id });
    }

    // POST /api/session/pair
    if (p === '/api/session/pair' && req.method === 'POST') {
        const body = await parseBody(req);
        const s = sessions.get(body.code);
        if (!s) return json(res, 404, { error: 'Invalid code' });
        s.paired = true;
        return json(res, 200, { sessionId: s.id, paired: true });
    }

    // POST /api/session/start
    if (p === '/api/session/start' && req.method === 'POST') {
        const body = await parseBody(req);
        const s = [...sessions.values()].find(x => x.id === body.sessionId);
        if (!s) return json(res, 404, { error: 'Not found' });
        s.active = true;
        s.exercise = body.exercise || s.exercise;
        s.reps = 0;
        s.feedback = [];
        s.formScore = null;
        s.lastAnalysis = null;
        s.elapsedStart = Date.now();
        return json(res, 200, { active: true });
    }

    // POST /api/session/stop
    if (p === '/api/session/stop' && req.method === 'POST') {
        const body = await parseBody(req);
        const s = [...sessions.values()].find(x => x.id === body.sessionId);
        if (!s) return json(res, 404, { error: 'Not found' });
        s.active = false;
        return json(res, 200, { active: false, reps: s.reps });
    }

    // POST /api/session/rep — phone sends rep count update
    if (p === '/api/session/rep' && req.method === 'POST') {
        const body = await parseBody(req);
        const s = [...sessions.values()].find(x => x.id === body.sessionId);
        if (!s) return json(res, 404, { error: 'Not found' });
        s.reps = body.reps || s.reps;
        s.exercise = body.exercise || s.exercise;
        // If feedback included (good rep), store it
        if (body.feedback) {
            s.lastAnalysis = { feedback: body.feedback.text, score: body.feedback.score, timestamp: Date.now() };
            s.feedback.unshift({ text: body.feedback.text, score: body.feedback.score, time: Date.now() });
            if (s.feedback.length > 30) s.feedback.pop();
            s.formScore = body.feedback.score;
        }
        return json(res, 200, { reps: s.reps });
    }

    // POST /api/session/analyze — phone sends keypoint data for AI analysis
    if (p === '/api/session/analyze' && req.method === 'POST') {
        const body = await parseBody(req);
        const s = [...sessions.values()].find(x => x.id === body.sessionId);
        if (!s) return json(res, 404, { error: 'Not found' });

        const result = await analyzeKeypoints(s.exercise, body.keypoints);
        s.lastAnalysis = { feedback: result.text, score: result.score, timestamp: Date.now() };
        s.feedback.unshift({ text: result.text, score: result.score, time: Date.now() });
        if (s.feedback.length > 30) s.feedback.pop();
        s.formScore = result.score;

        return json(res, 200, { feedback: result.text, score: result.score });
    }

    // POST /api/session/frame (kept for backward compat)
    if (p === '/api/session/frame' && req.method === 'POST') {
        const body = await parseBody(req);
        const s = [...sessions.values()].find(x => x.id === body.sessionId);
        if (!s) return json(res, 404, { error: 'Not found' });
        // If keypoints provided, use keypoint analysis
        if (body.keypoints) {
            const result = await analyzeKeypoints(s.exercise, body.keypoints);
            s.lastAnalysis = { feedback: result.text, score: result.score, timestamp: Date.now() };
            s.feedback.unshift({ text: result.text, score: result.score, time: Date.now() });
            if (s.feedback.length > 30) s.feedback.pop();
            s.formScore = result.score;
            return json(res, 200, { feedback: result.text, score: result.score, reps: s.reps });
        }
        return json(res, 200, { feedback: 'Use keypoint analysis', score: 'warning', reps: s.reps });
    }

    // GET /api/session/state
    if (p === '/api/session/state' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        const s = sessions.get(code);
        if (!s) return json(res, 404, { error: 'Not found' });
        return json(res, 200, {
            paired: s.paired, active: s.active, exercise: s.exercise,
            reps: s.reps, formScore: s.formScore,
            lastAnalysis: s.lastAnalysis,
            feedback: s.feedback.slice(0, 15),
            elapsed: s.elapsedStart ? Date.now() - s.elapsedStart : 0,
        });
    }

    // POST /api/chat — voice question from TV dashboard
    if (p === '/api/chat' && req.method === 'POST') {
        const body = await parseBody(req);
        const question = body.question || '';
        const sessionCode = body.code || '';
        const s = sessions.get(sessionCode);

        // Build context from session state
        let context = 'No active workout.';
        if (s && s.active) {
            context = `Active workout: ${s.exercise}. Reps completed: ${s.reps}. `
                + `Current form: ${s.formScore || 'unknown'}. `
                + `Recent feedback: ${s.feedback.slice(0,3).map(f=>f.text).join('; ')}`;
        }

        try {
            const prompt = `You are CouchCoach, a friendly AI fitness coach. The user is mid-workout and just asked you a question via voice.

Workout context: ${context}

User said: "${question}"

Respond in 1-2 short sentences. Be conversational, warm, and helpful. No emojis. No stage directions like *chuckles* or actions in asterisks. Just plain spoken words. Speak as if talking to them in person.`;

            const cmd = new InvokeModelCommand({
                modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
                contentType: 'application/json',
                body: JSON.stringify({
                    anthropic_version: 'bedrock-2023-05-31',
                    max_tokens: 80,
                    messages: [{ role: 'user', content: prompt }]
                }),
            });
            const resp = await bedrock.send(cmd);
            const result = JSON.parse(new TextDecoder().decode(resp.body));
            const answer = result.content[0].text.trim();
            return json(res, 200, { answer });
        } catch (e) {
            console.error('Chat error:', e.message);
            return json(res, 200, { answer: "Sorry, I didn't catch that. Keep going, you're doing great." });
        }
    }

    // GET /api/speech?text=... — convert text to speech via Polly
    if (p === '/api/speech' && req.method === 'GET') {
        const text = url.searchParams.get('text');
        if (!text) return json(res, 400, { error: 'Missing text param' });
        try {
            // Strip emojis and clean up for natural speech
            const clean = text
                .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
                .replace(/\*[^*]+\*/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const cmd = new SynthesizeSpeechCommand({
                Engine: 'neural',
                OutputFormat: 'mp3',
                VoiceId: 'Joanna',
                TextType: 'text',
                Text: clean,
            });
            const resp = await polly.send(cmd);
            const chunks = [];
            for await (const chunk of resp.AudioStream) { chunks.push(chunk); }
            const audio = Buffer.concat(chunks);
            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Content-Length': audio.length,
                'Access-Control-Allow-Origin': '*',
            });
            res.end(audio);
        } catch (e) {
            console.error('Polly error:', e.message);
            json(res, 500, { error: 'Speech synthesis failed' });
        }
        return;
    }

    if (p === '/api/health') return json(res, 200, { status: 'UP' });

    json(res, 404, { error: 'Not found' });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    let ip = 'localhost';
    for (const iface of Object.values(nets)) {
        for (const cfg of iface) {
            if (cfg.family === 'IPv4' && !cfg.internal) { ip = cfg.address; break; }
        }
    }
    console.log('\n  ╔══════════════════════════════════════╗');
    console.log('  ║         CouchCoach Server             ║');
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║  TV:    http://${ip}:${PORT}/tv`);
    console.log(`  ║  Phone: http://${ip}:${PORT}/phone`);
    console.log(`  ║  API:   http://${ip}:${PORT}/api/health`);
    console.log('  ╚══════════════════════════════════════╝\n');
});
