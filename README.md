# Clickipedia

![Clickipedia Promo Img](/public/Logo.png)
[Play Now](https://isabisabel.com/clickipedia/)

The Wiki clicker game. 
Can you open every article on the English Wikipedia? Probably not. 
Why don't you try, anyway?

## Development

The game reads Wikipedia's links from a prebuilt graph instead of asking
Wikipedia, so it needs to be told where that graph is. To run it locally
against the small test graph in this repository:

```sh
npm install
cp .env.example .env.development.local
npm run graph:serve -- --fixture   # in one terminal
npm run dev                        # in another
```

`npm test` runs the tests. Building the real graph from a Wikipedia dump,
publishing it to Cloudflare R2, and refreshing it are described in
[tools/wiki-graph/README.md](tools/wiki-graph/README.md).