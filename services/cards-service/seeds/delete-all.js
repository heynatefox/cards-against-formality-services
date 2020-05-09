const axios = require('axios').default;
const getAllIds = () => {
  return axios.post('http://localhost:8000/admin/decks/search')
    .then(res => res.data.map(d => d._id))
    .catch(err => console.log(err.message))
}

const start = async () => {
  const ids = await getAllIds();
  console.log(ids);
  Promise.all(ids.map(id => axios.delete(`http://localhost:8000/admin/decks/${id}`).catch(err => console.log(err.message))))
    .then(() => {
      console.log('finished deleting all');
    })
    .catch(err => console.log(err))
}

start();