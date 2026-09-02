const Filter = require('bad-words');

const filter = new Filter();

// Add class-specific terms to catch here, e.g.: filter.addWords('term1', 'term2');
// Remove any built-in word that's a false positive for your group with:
// filter.removeWords('word1', 'word2');

function containsBlockedWord(text) {
  return filter.isProfane(text);
}

module.exports = { containsBlockedWord };
