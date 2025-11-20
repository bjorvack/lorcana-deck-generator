# InkDecks Scraper

Scrapes tournament deck data from inkdecks.com and saves it to the `training_data` directory for model training.

## Usage

```bash
cd scraper
npm install
npm start
```

The scraper will:
1. Fetch the last 10 tournaments from inkdecks.com
2. Extract the top 16 decks from each tournament
3. Save each tournament's data as a JSON file in `../training_data/`
4. Update `../training_data/manifest.json` with new files

## Output Format

Each tournament JSON file contains:
```json
{
  "name": "Tournament Name",
  "url": "https://inkdecks.com/...",
  "decks": [
    {
      "cards": [
        { "name": "Card Name", "version": "Card Version or null", "amount": 4 }
      ]
    }
  ]
}
```
