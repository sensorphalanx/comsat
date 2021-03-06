// Parser for Blizzard's serialized JSONish binary format, NOW WITH STREAMING OOOOOOOOOOOOOOOOOOOOO

var util = require('util'),
    EventEmitter = require('events').EventEmitter,
    Buffers = require('buffers'),
    BigInteger = require('bigdecimal').BigInteger;

function Parser() {
  if(!(this instanceof Parser)) return new Parser();

  EventEmitter.call(this);

  this.error = null;
}

util.inherits(Parser, EventEmitter);

exports.Parser = Parser;

Parser.prototype.parse = function(stream, dataMap) {
  var self = this;
  this.dataMap = dataMap;
  this.state = [ ]; // state is a queue, if it has things in it, we read them in that order; if it does not, we try to read a type to re-populate the queue
  this.buffers = Buffers();

  this.error = null;
  this.initialParseCompleted = false;
  this.expectedItems = -1;
  this.itemsRead = 0;

  stream
    .on('error', function(err) {
      self._error(err);
    })
    .on('aborted', function() {
      self.emit('aborted');
    })
    .on('data', function(buffer) {
      buffers.push(buffer);
    })
    .on('end', function() {
      var buffer = this.buffers.toBuffer();
      var parsed;
      try {
        parsed = parseBuffer(buffer).value[0];
      }
      catch(err) {
        this._error(err);
        return;
      }

      mapDataToObject(parsed, dataMap, function onMappedData(err, mappedResult) {
        if(err)
          this._error(err);
        else {
          this.emit('data', mappedResult);
          this.emit('end');
        }
      });
    });

  return this;
}

Parser.prototype._error = function(err) {
  if(this.error) return;

  this.error = err;
  this.emit('error', err);
}

function mapDataToObject(arrData, arrMap, callback) {
  // takes an array of data and an array of names and/or {name, [type,] [map]} objects to recursively map the data to a named object
  // types can be: string, object, array
  // object is the default type
  // if string, the data at that position must be a buffer
  // if array, the data at that position must be an array of arrays
  if(!(arrData instanceof Array) || !(arrMap instanceof Array)) {
    callback(new Error('data and map are not arrays'));
    return;
  }
  if(arrData.length != arrMap.length) {
    callback(new Error('data array length[' + arrData.length + '] does not match map length[' + arrMap.length + ']'));
    return;
  }

  var retObj = { };

  for(var i = 0; i < arrData.length; i++) {
    if(typeof arrMap[i] === 'string') {
      retObj[arrMap[i]] = arrData[i];
    }
    else if(typeof arrMap[i] === 'object') {
      var mapObject = arrMap[i];
      if(!mapObject.name) {
        callback(new Error('malformed map'));
        return;
      }

      if(mapObject.type && mapObject.type === 'string') {
        if(!arrData[i] instanceof Buffer) {
          callback(new Error('cannot map non-Buffer object to a string'));
          return;
        }

        retObj[arrMap[i].name] = arrData[i].toString('utf8');
      }
      else if(mapObject.type && mapObject.type === 'array') {
        if(!mapObject.map) {
          // array of standard types
          // unnecessary way of doing this, but I'll allow it for now anyway
          if(!(arrData[i] instanceof Array)) {
            callback(new Error('cannot map from a non-array to an array'));
            return;
          }

          retObj[mapObject.name] = new Array();
          for(var j = 0; j < arrData[i].length; j++) {
            retObj[mapObject.name][j] = arrData[i][j];
          }
        }
        else {
          if(!(arrData[i] instanceof Array) || !(arrData[i][0] instanceof Array)) {
            callback(new Error('map is trying to create an array where there isn\'t one'));
            return;
          }

          retObj[arrMap[i].name] = new Array();
          for(var j = 0; j < arrData[i].length; j++) {
            (function(i, j) {
              mapDataToObject(arrData[i][j], arrMap[i].map, function(err, obj) {
                if(err)
                  callback(err);
                else
                  retObj[arrMap[i].name][j] = obj;
              });
            })(i, j);
          }
        }
      }
      else if(mapObject.map && (!mapObject.type || mapObject.type === 'object')) {
        (function(i) {
          mapDataToObject(arrData[i], arrMap[i].map, function(err, obj) {
            if(err)
              callback(err);
            else
              retObj[arrMap[i].name] = obj;
          });
        })(i);
      }
      else {
        callback(new Error('malformed map'));
        return;
      }
    }
    else {
      callback(new Error('maps must contain only strings and objects'));
      return;
    }
  }

  callback(null, retObj);
}

function parseBuffer(buf, itemCount) {
  itemCount = itemCount || -1;
  var value = [ ];
  var bytesRead = 0;

  while((itemCount < 0 || value.length < itemCount) && buf.length > 0) {
    var type = buf[0];
    buf = buf.slice(1);
    bytesRead += 1;

    var read; // will be { value = <value of proper type>; bytesRead = <number of bytes read (slice off buffer)> }
    switch(type) {
      case 2:
        read = readByteString(buf);
        break;
      case 4:
        read = readArray(buf);
        break;
      case 5:
        read = readHash(buf);
        break;
      case 6:
        read = readInt8(buf);
        break;
      case 7:
        read = readInt32(buf);
        break;
      case 9:
        read = readIntV(buf);
        break;
    }

    if(read) {
      bytesRead += read.bytesRead;
      buf = buf.slice(read.bytesRead);
      value.push(read.value);
    }
    else {
      value.push(null);
    }
  }
  
  return { value: value, bytesRead: bytesRead };
}

function readByteString(buf) {
  var strLenVlf = readIntV(buf);
  var strLen = strLenVlf.value;
  if(strLen < 0)
    throw new Error("strLen is less than 0");

  var bytes = new Buffer(strLen);
  buf.copy(bytes, 0, strLenVlf.bytesRead, strLen+strLenVlf.bytesRead);

  return { value: bytes, bytesRead: strLen + strLenVlf.bytesRead };
}

function readArray(buf) {
  if(buf[0] != 1 || buf[1] != 0) throw "Malformed array, [0..1] != {0x1, 0x0}";
  buf = buf.slice(2);
  var lenVlf = readIntV(buf);
  var arrayLen = lenVlf.value;
  var totalBytesRead = lenVlf.bytesRead + 2;
  if(arrayLen < 0) throw new Error("arrayLen is less than 0 :(");
  buf = buf.slice(lenVlf.bytesRead);

  var parseResult = parseBuffer(buf, arrayLen);

  totalBytesRead += parseResult.bytesRead;
  return { value: parseResult.value, bytesRead: totalBytesRead };
}

function readHash(buf) {
  var lenVlf = readIntV(buf);
  var hashLen = lenVlf.value;
  var totalBytesRead = lenVlf.bytesRead;
  if(hashLen < 0) throw new Error("hashLen < 0 :(");
  buf = buf.slice(lenVlf.bytesRead);

  // to make things easier to work with in mapping to objects, hashes map to arrays (since all keys are numeric indexes anyway).
  // be aware, however, that the keys are not always sequential, for instance in the player ID data, it goes 0, 1, 2, 4
  // when creating maps, you need to take this into account to ensure that the map length equals the data length (IE: for player ID, need length 5 instead of 4)
  var outHash = new Array();

  for(var i = 0; i < hashLen; i++) {
  var keyVlf = readIntV(buf);
  var key = keyVlf.value;
  totalBytesRead += keyVlf.bytesRead;
  buf = buf.slice(keyVlf.bytesRead);

  var parseResult = parseBuffer(buf, 1);

  buf = buf.slice(parseResult.bytesRead);
  totalBytesRead += parseResult.bytesRead;
  if(parseResult.value.length > 0)
    outHash[key] = parseResult.value[0];
  }

  return { value: outHash, bytesRead: totalBytesRead };
}

function readInt8(buf) {
  var int8 = buf[0];
  int8 = Math.pow(-1, int8 & 0x1) * (int8 >>> 1);

  return { value: int8, bytesRead: 1 };
}

function readInt32(buf) {
  var int32 = (buf[3] << 23) | (buf[2] << 15) | (buf[1] << 7) | (buf[0] >>> 1);
  int32 = Math.pow(-1, buf[0] & 1) * int32;

  return { value: int32, bytesRead: 4 };
}

function readIntV(buf) {
  var len = 0;
  var result = BigInteger.valueOf(0);
  while(true) {
    var val = buf[len];
    if((val & 0x80) > 0) {
      result = result.add(BigInteger.valueOf(val & 0x7F).shiftLeft(7*len));
      len++;
    }
    else {
      // last byte
      result = result.add(BigInteger.valueOf(val).shiftLeft(7*len));
      len++;
      break;
    }
  }

  result = result.shiftRight(1).multiply(BigInteger.valueOf(Math.pow(-1, result & 0x1)));
  if(len <= 4) // representable as a regular number
    result = result.intValue();

  return { value: result, bytesRead: len };
}
