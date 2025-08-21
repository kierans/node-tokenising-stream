const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { pipeline } = require("node:stream/promises");

const sax = require("sax");
const { InflatingTransform } = require("inflating-transform");

const { TokenisingStream } = require("../index");

/*
 * This example demonstrates the use of a TokenisingStream in a stream flow
 * that is back-pressure safe.
 *
 * The script takes an XML filename as the first arg and parses the file.
 * Events from the SAX Parser are captured and piped to STDOUT.
 *
 * Usage: node example1.js books.xml
 */

/**
 * @implements EventAdaptor
 *
 * Events that are emitted are in sax.EVENTS
 *
 * @see https://www.npmjs.com/package/sax
 */
class SAXEventAdaptor extends EventEmitter {
	constructor(delegate) {
		super();

		this.inTag = false;

		delegate.on("opentag", (token) => {
			this.inTag = true;

			this.emit(TokenisingStream.TOKEN_EVENT_NAME, Object.assign({}, token, {
				type: "opentag"
			}));
		})

		delegate.on("closetag", (token) => {
			this.inTag = false;

			this.emit(TokenisingStream.TOKEN_EVENT_NAME, {
				name: token,
				type: "closetag"
			});
		})

		delegate.on("text", (token) => {
			const trimmed = token.trim();

			if (this.inTag && trimmed.length > 0) {
				this.emit(TokenisingStream.TOKEN_EVENT_NAME, {
					text: trimmed,
					type: "text"
				});
			}
		})

		delegate.on("error", (error) => {
			this.emit(TokenisingStream.ERROR_EVENT_NAME, error);
		})
	}
}

// open :: String -> ReadStream
const open = (fle) => fs.createReadStream(fle, { encoding: "utf8" });

// tokenisingStream :: () -> TokenisingStream
const tokenisingStream = () => {
	const delegate = sax.createStream(true);

	return new TokenisingStream({
		delegate,
		adaptor: new SAXEventAdaptor(delegate)
	})
}

// stringifierStream :: () -> InflatingTransform
const stringifierStream = () =>
	new InflatingTransform({
		writableObjectMode: true,
		inflate: function*(chunk, _) {
			yield {
				chunk: `${JSON.stringify(chunk)}\n`,
				encoding: "utf8"
			}
		}
	})

// main :: [String] -> Promise Unit
const main = async (argv) => {
	if (argv.length < 1) {
		console.error("Usage: example1 <file>");
		process.exit(1);
	}

	const xml = open(argv[0]);

	await pipeline(
		xml,
		tokenisingStream(),
		stringifierStream(),
		process.stdout
	)
}

main(process.argv.slice(2)).catch(console.error);
