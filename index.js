const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Statik dosyaları sun
app.use(express.static('docs'));

app.listen(port, () => {
	console.log(`Sunucu http://localhost:${port} adresinde çalışıyor`);
});
