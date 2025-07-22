#!/usr/bin/env node

const { MongoClient } = require('mongodb');
const readline = require('readline');
const url = require('url');
const querystring = require('querystring');

// CLI Input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Ask for Mongo URI
rl.question('Enter MongoDB connection URI: ', async (uri) => {
  const parsedUrl = url.parse(uri);
  const params = querystring.parse(parsedUrl.query);

  const options = {};

  // TLS support
  if (params.tlsCertificateKeyFile && params.tlsCAFile) {
    options.tls = true;
    options.tlsCertificateKeyFile = decodeURIComponent(params.tlsCertificateKeyFile);
    options.tlsCAFile = decodeURIComponent(params.tlsCAFile);
    options.tlsAllowInvalidCertificates = true; // Optional

    console.log('🔑 TLS Certificate Key File:', options.tlsCertificateKeyFile);
    console.log('🔑 TLS CA File:', options.tlsCAFile);
  }
rl.close();
  try {
    const client = new MongoClient(uri, options);
    await client.connect();
    console.log('✅ Connected to MongoDB');

    let currentDb = client.db(); // Default DB from URI

    const shell = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${currentDb.databaseName} > `
    });

    shell.prompt();

    shell.on('line', async (line) => {
      const input = line.trim();

      if (input === 'exit' || input === 'quit') {
        console.log('👋 Bye!');
        await client.close();
        shell.close();
        process.exit(0);
      }

      if (input.startsWith('use ')) {
        const dbname = input.split(' ')[1];
        if (!dbname) {
          console.log('⚠️  Usage: use <dbname>');
        } else {
          currentDb = client.db(dbname);
          shell.setPrompt(`${dbname} >`);
          console.log(`✅ Switched to DB: ${dbname}`);
        }
        shell.prompt();
        return;
      }

      if (input === 'databases') {
        const dbs = await client.db().admin().listDatabases();
        console.log('📚 Databases:');
        dbs.databases.forEach((db) => console.log(` - ${db.name}`));
        shell.prompt();
        return;
      }

      if (input === 'collections') {
        const collections = await currentDb.listCollections().toArray();
        console.log(`📁 Collections in "${currentDb.databaseName}":`);
        collections.forEach((col) => console.log(` - ${col.name}`));
        shell.prompt();
        return;
      }

      try {
        // Allow querying: db.collection.find({}).toArray()
        const result = await eval(`(async () => ${input})()`);
        console.dir(result, { depth: null });
      } catch (err) {
        console.error(`❌ Error: ${err.message}`);
      }

      shell.prompt();
    });

    shell.on('close', async () => {
      console.log('\n👋 Bye!');
      await client.close();
      shell.close();
      process.exit(0);
    });

  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    if (client) await client.close();
    if (rl) rl.close();
    process.exit(1);
  }
});
