require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Sentiment = require('sentiment');
const { MongoClient } = require('mongodb');
const puppeteer = require('puppeteer');

const sentiment = new Sentiment();
const app = express();

app.use(cors());
app.use(bodyParser.json());

const client = new MongoClient(process.env.MONGODB_URI, { useUnifiedTopology: true });
let db;


async function connectDB() {
  try {
    await client.connect();
    db = client.db("sih_db");
    console.log("✅ Connected to MongoDB Atlas");
  } catch (err) {
    console.error("❌ DB connection error:", err);
  }
}
connectDB();

// ============================ WEBSITE CONFIG ============================
const siteConfigs = {
  'www.wellkeyhealth.com': {
    scrape: async (page) => {
      console.log('Using Wellkey Health scraping logic...');
      const containerSelector = 'div.testimonial_wrapper';
      await page.waitForSelector(containerSelector, { timeout: 10000 });

      const comments = await page.evaluate(() => {
        const commentElements = Array.from(document.querySelectorAll('div.testimonial_content p'));
        return commentElements.map(el => el.innerText.trim());
      });
      return comments.slice(0, 20); // top 20 comments
    }
  }
};

// ============================ ANALYZE ROUTE ============================
app.post('/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send({ message: "URL is required" });

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    return res.status(400).send({ message: "Invalid URL format" });
  }

  const config = siteConfigs[hostname];
  if (!config) return res.status(400).send({ message: `Scraping not supported for: ${hostname}` });

  let browser;
  try {
    console.log(`Scraping URL: ${url}`);
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2' });

    const comments = await config.scrape(page);
    await browser.close();

    if (comments.length === 0) return res.status(404).send({ message: "No comments found." });

    const analyzedComments = comments.map(comment => {
      const result = sentiment.analyze(comment);
      let sentimentResult = 'neutral';
      if (result.score > 0) sentimentResult = 'positive';
      else if (result.score < 0) sentimentResult = 'negative';
      return { text: comment, sentiment: sentimentResult };
    });

    const newUrlAnalysis = { url, analyzedComments, timestamp: new Date() };
    const dbResponse = await db.collection("urls").insertOne(newUrlAnalysis);
    res.status(201).send({ _id: dbResponse.insertedId, ...newUrlAnalysis });

  } catch (err) {
    console.error(`Error scraping ${url}:`, err);
    if (browser) await browser.close();
    res.status(500).send({ message: "Error scraping the page. Structure may have changed." });
  }
});

// ============================ GET ANALYZED RESULTS ============================
app.get('/analyze', async (req, res) => {
  try {
    const urls = await db.collection("urls").find().sort({ timestamp: -1 }).toArray();
    res.send(urls);
  } catch (err) {
    res.status(500).send("DB error");
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
