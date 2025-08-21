const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");

const {
	allOf,
	anything,
	assertThat,
	equalTo,
	everyItem,
	hasProperty,
	hasSize,
	instanceOf,
	is,
	isEmpty,
	isFulfilledWith,
	number,
	promiseThat,
	throws,
} = require("hamjest");

const { TokenisingStream } = require("../index");

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

		delegate.on("invalid_number", (err) => {
			this.emit("error", err);
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
		const words = chunk.split(",");

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			const token = {
				input: word,
				value: parseInt(word, 10)
			}

			this._emitToken(token);
		}

		callback(result);
	}

	_final(callback) {
		this._emitToken({ value: -1 });

		callback(this._errorOnClose ? new Error("Closing error") : undefined);
	}

	_emitToken(token) {
		if (isNaN(token.value)) {
			this.emit("invalid_number", new Error(`Invalid number: ${token.input}`));
			return;
		}

		this.emit("token", {
			type: "token",
			value: token.value
		})
	}
}

class FakeWritable extends EventEmitter {
	constructor() {
		super();

		this.endEvent = "finish"
	}

	write(chunk, encoding) {}

	end() {
		this.emit(this.endEvent);
	}

	setEndEvent(endEvent) {
		this.endEvent = endEvent;
	}
}

describe("TokenisingStream", function() {
	describe("streaming", function() {
		it("should stream events", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end(numbersText());

			await promiseThat(pipeline, isFulfilledWith(events(everyItem(allOf(
				hasProperty("type", equalTo("token")),
				hasProperty("value", is(number()))
			)))))
		});

		it("should proxy callback error from delegate", async function() {
			const text = "This is error text";
			const stream = newTokenisingStream({
				delegate: new TestWritable({ errorOnWrite: true })
			});

			const pipeline = newPipeline(stream);
			stream.end(text);

			await promiseThat(pipeline, isFulfilledWith(anError(errorMatcher(equalTo(text)))))
		});

		it("should stop listening for events after parsing chunk", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end(numbersText());

			await pipeline;

			assertThat("Still listening for events", stream.adaptor.listenerCount("event"), equalTo(0));
		});

		it("should work with fake writable streams", async function() {
			const stream = newTokenisingStream({
				delegate: new FakeWritable()
			});
			const pipeline = newPipeline(stream);
			stream.end(numbersText());

			await pipeline;
		});

		describe("events", function() {
			const events = [
				"close",
				"finish",
				"end"
			]

			let delegate;

			beforeEach(function() {
				delegate = new FakeWritable();
			});

			events.forEach((event) => {
				it(`should recognise delegate ended with '${event}' event`, async function() {
					delegate.setEndEvent(event);

					const stream = newTokenisingStream({ delegate });
					const pipeline = newPipeline(stream);
					stream.end(numbersText());

					await pipeline;
				});
			})
		});
	});

	describe("flushing", function() {
		it("should flush events after closing delegate", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end(numbersText());

			const result = await pipeline;
			const events = result.events;

			// cater for the final token when flushing.
			assertThat(events.length, equalTo(NUM_EVENTS + 1));
			assertThat(events[events.length - 1].value, equalTo(-1));
		});

		it("should proxy error from delegate", async function() {
			const stream = newTokenisingStream({
				delegate: new TestWritable({ errorOnClose: true })
			});

			const pipeline = newPipeline(stream);
			stream.end(numbersText());

			await promiseThat(pipeline, isFulfilledWith(anError(errorMatcher(anything()))))
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

	describe("adaptor events", function() {
		it("should proxy error event from adaptor", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end("abc");

			await promiseThat(pipeline, isFulfilledWith(anError(errorMatcher(anything()))));
		});

		it("should emit tokens collected before error event", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end("1,2,abc");


			await promiseThat(pipeline, isFulfilledWith(events(hasSize(2))));
		});

		it("should stop listening for tokens after error event", async function() {
			const stream = newTokenisingStream({});
			const pipeline = newPipeline(stream);
			stream.end("abc,1,2");

			await promiseThat(pipeline, isFulfilledWith(events(isEmpty())));
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

// newPipeline :: TokenisingStream -> Promise Error [a]
const newPipeline = (stream) =>
	new Promise((resolve) => {
		const events = [];

		stream.on("data", (event) => {
			events.push(event);
		})

		stream.once("end", () => {
			resolve({
				events,
				err: null,
			});
		});

		stream.once("error", (err) => {
			resolve({
				events,
				err
			});
		});
	})

// numbersText :: () -> String
const numbersText = () => {
	const nums = []

	for (let i = 0; i < NUM_EVENTS; i++) {
		nums.push(i);
	}

	return nums.join(",");
}

// anError :: Matcher -> Matcher
const anError = (matcher) =>
	hasProperty("err", matcher)

// errorMatcher :: Matcher -> Matcher
const errorMatcher = (matcher) =>
	allOf(
		instanceOf(Error),
		hasProperty("message", matcher)
	)

// events :: Matcher -> Matcher
const events = (matcher) =>
	hasProperty("events", matcher)
