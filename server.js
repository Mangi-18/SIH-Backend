const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Sentiment = require('sentiment');
const { MongoClient } = require('mongodb');
const puppeteer = require('puppeteer');

const sentiment = new Sentiment();
const app = express();

app.use(cors());
// Using bodyParser is more explicit for older Express versions, but express.json() is fine too.
app.use(bodyParser.json());

// ====================================================================================
// IMPORTANT: Use your MongoDB Atlas connection string here.
// The code you provided used a local DB, which might not be what you want.
// ====================================================================================
const uri = "mongodb+srv://akhilmgen_db_user:V69gKrRUM86KTdbz@cluster0.ihxl5rf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, { useUnifiedTopology: true });
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

// ====================================================================================
// WEBSITE SCRAPING CONFIGURATION
// This is the "brain" of the scraper. To support a new site, just add its
// specific instructions here.
// ====================================================================================
const siteConfigs = {
  'www.wellkeyhealth.com': {
    scrape: async (page) => {
      console.log('Using Wellkey Health scraping logic...');
      const containerSelector = 'div.testimonial_wrapper';
      await page.waitForSelector(containerSelector, { timeout: 15000 });
      
      const comments = await page.evaluate(() => {
        const commentElements = Array.from(document.querySelectorAll('div.testimonial_content p'));
        return commentElements.map(el => el.innerText.trim());
      });
      return comments;
    }
  },
  'www.apollo247.com': {
    scrape: async (page) => {
      console.log('Using Apollo 247 scraping logic...');
      const containerSelector = 'div[data-testid="pdp-review-item-main-div"]';
      await page.waitForSelector(containerSelector, { timeout: 15000 });

      const comments = await page.evaluate((selector) => {
        const reviewContainers = Array.from(document.querySelectorAll(selector));
        return reviewContainers.map(container => {
          const textEl = container.querySelector('p');
          return textEl ? textEl.innerText.trim() : '';
        });
      }, containerSelector);
      return comments;
    }
  }
};


// ====================================================================================
// THE MAIN ANALYZE ROUTE
// This route identifies the website from the URL and uses the correct
// scraping function from the `siteConfigs` object above.
// ====================================================================================
app.post('/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ message: "URL is required" });
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    return res.status(400).json({ message: "Invalid URL format" });
  }

  const config = siteConfigs[hostname];

  if (!config) {
    return res.status(400).json({ message: `Scraping is not supported for the website: ${hostname}` });
  }

  let browser;
  try {
    console.log(`Attempting to scrape URL: ${url} with config for ${hostname}`);
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); // Increased timeout for slow pages

    const comments = await config.scrape(page);
    await browser.close();

    const filteredComments = comments.filter(text => text && text.length > 10);

    if (filteredComments.length === 0) {
      return res.status(404).json({ message: "No valid comments were found on the page." });
    }

    const analyzedComments = filteredComments.map(comment => {
      const result = sentiment.analyze(comment);
      let sentimentResult = 'neutral';
      if (result.score > 0) sentimentResult = 'positive';
      else if (result.score < 0) sentimentResult = 'negative';
      return { text: comment, sentiment: sentimentResult };
    });

    const newUrlAnalysis = { url, analyzedComments, timestamp: new Date() };
    const dbResponse = await db.collection("urls").insertOne(newUrlAnalysis);
    res.status(201).json({ _id: dbResponse.insertedId, ...newUrlAnalysis });

  } catch (err) {
    console.error(`Error scraping ${url}:`, err);
    if (browser) await browser.close();
    res.status(500).json({ message: "An error occurred during scraping. The page structure may have changed, the URL is invalid, or the connection timed out." });
  }
});


// GET route to fetch all previous analyses
app.get('/analyze', async (req, res) => {
  try {
    const urls = await db.collection("urls").find().sort({ timestamp: -1 }).toArray();
    res.json(urls);
  } catch (err) {
    res.status(500).json({ message: "DB error" });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
