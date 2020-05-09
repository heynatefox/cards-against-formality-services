const axios = require('axios');
const json = require('./cards.json');
let { blackCards, whiteCards, order, ...decks } = json;

blackCards = blackCards.map(card => {
  return { ...card, cardType: 'black' }
});

whiteCards = whiteCards.map(card => {
  return { text: card, cardType: 'white' }
});

const postCard = (data, i) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      return axios.post('http://localhost/admin/cards', data)
        .then(res => { resolve(res.data) })
        .catch(err => {
          console.log(err);
          return resolve(null);
        })
    }, 30 * i);
  })
}

const postDeck = (data) => {
  return axios.post('http://localhost:8000/admin/decks', data)
    .then(res => res.data)
    .catch(err => {
      console.log(err.message);
      return null;
    })
}

const populateDeck = (deck) => {
  return Promise.all(deck.map((card, i) => postCard(card, i)))
}

const run = async () => {
  const populatedWhiteCards = await populateDeck(whiteCards);
  const populatedBlackCards = await populateDeck(blackCards);

  for (const deck of Object.values(decks)) {
    const populatedDeck = deck;
    //
    const blackCardIds = [];
    populatedDeck.black.map(index => {
      if (populatedBlackCards[index]) {
        blackCardIds.push(populatedBlackCards[index]._id);
      }
    });
    delete populatedDeck.black;
    populatedDeck.blackCards = blackCardIds;
    //
    const whiteCardIds = [];
    populatedDeck.white.map(index => {
      if (populatedWhiteCards[index]) {
        whiteCardIds.push(populatedWhiteCards[index]._id);
      }
    });
    delete populatedDeck.white
    populatedDeck.whiteCards = whiteCardIds;


    try {
      await postDeck(populatedDeck)
    } catch (e) {
      console.log(e.message);
    }
  }

  console.log('done');
}

run();