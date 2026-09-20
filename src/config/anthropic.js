const Anthropic = require('@anthropic-ai/sdk');

// Reads ANTHROPIC_API_KEY from the environment by default.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

module.exports = anthropic;
