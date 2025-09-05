require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Sentiment = require('sentiment');
const { MongoClient, ObjectId } = require('mongodb');
const fetch = require('node-fetch');

// ============================ INITIALIZATION ============================
const sentiment = new Sentiment();
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ============================ DB & ENV VALIDATION ============================
if (!process.env.MONGODB_URI) {
    console.error("❌ FATAL: MONGODB_URI not found in .env file. Exiting.");
    process.exit(1);
}
if (!process.env.SERPAPI_KEY) {
    console.error("❌ FATAL: SERPAPI_KEY not found in .env file. Exiting.");
    process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
    try {
        await client.connect();
        db = client.db("sentiment_analysis_db");
        console.log("✅ Connected to MongoDB Atlas");
    } catch (err) {
        console.error("❌ DB connection error:", err);
        process.exit(1);
    }
}
connectDB();

// ============================ HELPERS ============================
const isUrl = (string) => {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
};

function extractPlaceNameFromUrl(url) {
    try {
        const decoded = decodeURIComponent(url);
        const match = decoded.match(/\/place\/([^/]+)/);
        if (match && match[1]) {
            return match[1].replace(/\+/g, " ");
        }
        return null;
    } catch {
        return null;
    }
}

async function getPlaceIdFromName(name) {
    const apiKey = process.env.SERPAPI_KEY;
    const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(name)}&type=search&hl=en&gl=in&api_key=${apiKey}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || data.error) {
            console.error(`❌ SerpApi Error for query "${name}":`, data.error || `${response.status} ${response.statusText}`);
            return null;
        }

        let placeId = data.place_results?.place_id
                     || data.local_results?.[0]?.place_id
                     || data.local_results?.[0]?.gps_coordinates?.place_id;

        if (!placeId) {
            console.warn(`⚠️ No place_id found for query: "${name}"`);
            console.log("🔎 FULL SERPAPI RESPONSE DUMP:", JSON.stringify(data, null, 2));
            return null;
        }

        console.log(`✅ Found placeId for "${name}": ${placeId}`);
        return placeId;

    } catch (error) {
        console.error("❌ CRITICAL: Failed to fetch or parse JSON from SerpApi:", error);
        return null;
    }
}

// THIS IS THE UPDATED FUNCTION
async function getReviewsFromPlaceId(placeId) {
    const apiKey = process.env.SERPAPI_KEY;
    // Define the different review sorting methods we want to fetch
    const reviewSorts = ['newest', 'lowest_rating', 'highest_rating'];

    // Create an array of promises, one for each API call
    const fetchPromises = reviewSorts.map(sortBy => {
        const url = `https://serpapi.com/search.json?engine=google_maps_reviews&place_id=${placeId}&sort_by=${sortBy}&api_key=${apiKey}`;
        return fetch(url).then(res => {
            if (!res.ok) {
                console.error(`❌ SerpApi Reviews Error for placeId "${placeId}" with sort "${sortBy}": ${res.status} ${res.statusText}`);
                return { reviews: [] }; // Return an empty structure on error
            }
            return res.json();
        });
    });

    try {
        // Wait for all three API calls to complete in parallel
        const results = await Promise.all(fetchPromises);

        // Combine the reviews from all three calls into a single array
        const allReviews = results.flatMap(data => data.reviews || []);
        
        // Use a Map to remove duplicate reviews, as some might appear in multiple sorts
        const uniqueReviews = new Map();
        allReviews.forEach(review => {
            if (review && review.snippet) {
                uniqueReviews.set(review.snippet, review);
            }
        });
        
        console.log(`✅ Fetched a total of ${uniqueReviews.size} unique reviews for placeId: ${placeId}`);
        
        // Return an array of just the review text (snippets)
        return Array.from(uniqueReviews.values()).map(r => r.snippet);

    } catch (error) {
        console.error("❌ CRITICAL: Failed to fetch or parse reviews JSON from SerpApi:", error);
        return [];
    }
}


// ============================ ROUTES ============================
app.post('/analyze', async (req, res) => {
    const { input } = req.body;
    if (!input || typeof input !== 'string' || input.trim() === '') {
        return res.status(400).send({ message: "Input is required and must be a non-empty string." });
    }

    try {
        let placeName;
        if (isUrl(input)) {
            placeName = extractPlaceNameFromUrl(input);
            if (!placeName) {
                return res.status(400).send({ message: "Could not extract a valid place name from the provided URL." });
            }
        } else {
            placeName = input;
        }

        const placeId = await getPlaceIdFromName(placeName);
        if (!placeId) {
            return res.status(404).send({ message: `Could not find a location for "${placeName}". Check logs for full SerpApi response.` });
        }

        const cachedResult = await db.collection("analyses").findOne({ placeId });
        if (cachedResult) {
            console.log(`✅ Returning cached result for placeId: ${placeId}`);
            return res.status(200).json(cachedResult);
        }

        const comments = await getReviewsFromPlaceId(placeId);

        let analysisSummary = { positive: 0, negative: 0, neutral: 0, total: comments.length, overallScore: 0 };
        const analyzedComments = comments.map(comment => {
            const result = sentiment.analyze(comment);
            analysisSummary.overallScore += result.score;
            let sentimentResult = 'neutral';

            if (result.score > 0) {
                sentimentResult = 'positive';
                analysisSummary.positive++;
            } else if (result.score < 0) {
                sentimentResult = 'negative';
                analysisSummary.negative++;
            } else {
                sentimentResult = 'neutral';
                analysisSummary.neutral++;
            }
            return { text: comment, sentiment: sentimentResult, score: result.score };
        });

        let overallSentiment = 'neutral';
        if (analysisSummary.total > 0) {
            const averageScore = analysisSummary.overallScore / analysisSummary.total;
            if (averageScore > 0.5) overallSentiment = 'positive';
            else if (averageScore < -0.5) overallSentiment = 'negative';
        }

        analysisSummary.overallSentiment = comments.length > 0 ? overallSentiment : 'no_reviews';

        const newAnalysis = {
            input,
            placeName,
            placeId,
            analysis: analysisSummary,
            analyzedComments,
            timestamp: new Date(),
        };

        const dbResponse = await db.collection("analyses").insertOne(newAnalysis);
        res.status(201).send({ _id: dbResponse.insertedId, ...newAnalysis });

    } catch (err) {
        console.error("❌ Unhandled error in /analyze route:", err);
        res.status(500).send({ message: "An internal server error occurred.", error: err.message });
    }
});

app.get('/analyses', async (req, res) => {
    try {
        const analyses = await db.collection("analyses").find().sort({ timestamp: -1 }).toArray();
        res.status(200).json(analyses);
    } catch (err) {
        res.status(500).send({ message: "Database error while fetching analyses.", error: err.message });
    }
});

// ============================ START SERVER ============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});