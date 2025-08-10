const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");

const {
	allOf,
	anything,
	assertThat,
	equalTo,
	everyItem,
	hasProperty,
	instanceOf,
	is,
	isRejectedWith,
	number,
	promiseThat,
	throws
} = require("hamjest");

const TokenisingStream = require("../index");

const NUM_EVENTS = 3;

/**
 * @implements EventAdaptor
 */
class TestEventAdaptor extends EventEmitter {
	constructor(delegate) {
		super();

		delegate.on("token", (token) => {
			this.emit(TokenisingStream.TOKEN_EVENT_NAME, token);
		})
	}
}

/*
 * A Writable that embeds a simple number parser.
 * The input text is a string of comma-separated numbers.
 */
class TestWritable extends Writable {
	constructor(opts) {
		super(Object.assign({}, opts, {
			decodeStrings: false,
			defaultEncoding: "utf8",
		}));

		this._errorOnWrite = opts && opts.errorOnWrite || false;
		this._errorOnClose = opts && opts.errorOnClose || false;
	}

	_write(chunk, encoding, callback) {
		const result = this._errorOnWrite ? new Error(chunk) : undefined;
		const tokens = chunk.split(",");

		for (let i = 0; i < tokens.length; i++) {
			this._emitToken(parseInt(tokens[i], 10));
		}

		callback(result);
	}

	_final(callback) {
		this._emitToken(-1);

		callback(this._errorOnClose ? new Error("Closing error") : undefined);
	}

	_emitToken(value) {
		this.emit("token", {
			type: "token",
			value
		})
	}
}

describe("TokenisingStream", function() {
	describe("streaming", function() {
		it("should stream events", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end(testText());

			const events = await pipeline;

			assertThat(events, everyItem(allOf(
				hasProperty("type", equalTo("token")),
				hasProperty("value", is(number()))
			)))
		});

		it("should proxy error from delegate", async function() {
			const text = "This is error text";
			const stream = newTokenisingStream({
				delegate: new TestWritable({ errorOnWrite: true })
			});

			const pipeline = newPipeline(stream);
			stream.end(text);

			await promiseThat(pipeline, isRejectedWith(errorMatcher(equalTo(text))))
		});

		it("should stop listening for events after parsing chunk", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end(testText());

			await pipeline;

			assertThat("Still listening for events", stream.adaptor.listenerCount("event"), equalTo(0));
		})
	});

	describe("flushing", function() {
		it("should flush events after closing delegate", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end(testText());

			const events = await pipeline;

			// cater for the final token when flushing.
			assertThat(events.length, equalTo(NUM_EVENTS + 1));
			assertThat(events[events.length - 1].value, equalTo(-1));
		});

		it("should proxy error from delegate", async function() {
			const stream = newTokenisingStream({
				delegate: new TestWritable({ errorOnClose: true })
			});

			const pipeline = newPipeline(stream);
			stream.end(testText());

			await promiseThat(pipeline, isRejectedWith(errorMatcher(anything())))
		});
	});

	describe("construction", function() {
		it("should throw error if no delegate provided", function() {
			const opts = {
				adaptor: new EventEmitter()
			};

			assertThat(() => new TokenisingStream(opts), throws(errorMatcher(equalTo("Missing delegate option"))))
		});

		it("should throw error if no event adaptor provided", function() {
			const opts = {
				delegate: new TestWritable({})
			};

			assertThat(() => new TokenisingStream(opts), throws(errorMatcher(equalTo("Missing adaptor option"))))
		});
	});
});

// newTokenisingStream :: TokenisingStreamOptions -> TokenisingStream
const newTokenisingStream = (opts) => {
	const delegate = opts.delegate || new TestWritable({});

	return new TokenisingStream(Object.assign({}, opts, {
		adaptor: new TestEventAdaptor(delegate),
		delegate,
		defaultEncoding: "utf8",
		decodeStrings: false,
	}));
}

// newPipeline :: TokenisingStream -> Promise Error Unit
const newPipeline = (stream) =>
	new Promise((resolve, reject) => {
		const events = [];

		stream.on("data", (event) => {
			events.push(event);
		})

		stream.once("end", () => {
			resolve(events);
		});

		stream.once("error", (err) => {
			reject(err);
		});
	})

// testText :: () -> String
const testText = () => {
	const nums = []

	for (let i = 0; i < NUM_EVENTS; i++) {
		nums.push(i);
	}

	return nums.join(",");
}

// errorMatcher :: Matcher -> Matcher
const errorMatcher = (matcher) =>
	allOf(
		instanceOf(Error),
		hasProperty("message", matcher)
	)
