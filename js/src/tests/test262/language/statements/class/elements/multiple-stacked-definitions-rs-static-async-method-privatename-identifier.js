// |reftest| skip -- class-static-methods-private,class-fields-public is not supported
// This file was procedurally generated from the following sources:
// - src/class-elements/rs-static-async-method-privatename-identifier.case
// - src/class-elements/productions/cls-decl-multiple-stacked-definitions.template
/*---
description: Valid Static AsyncMethod PrivateName (multiple stacked fields definitions through ASI)
esid: prod-FieldDefinition
features: [class-static-methods-private, class, class-fields-public]
flags: [generated, async]
includes: [propertyHelper.js]
info: |
    ClassElement :
      MethodDefinition
      static MethodDefinition
      FieldDefinition ;
      static FieldDefinition ;
      ;

    MethodDefinition :
      AsyncMethod

    AsyncMethod :
      async [no LineTerminator here] ClassElementName ( UniqueFormalParameters ){ AsyncFunctionBody }

    ClassElementName :
      PropertyName
      PrivateName

    PrivateName ::
      # IdentifierName

    IdentifierName ::
      IdentifierStart
      IdentifierName IdentifierPart

    IdentifierStart ::
      UnicodeIDStart
      $
      _
      \ UnicodeEscapeSequence

    IdentifierPart::
      UnicodeIDContinue
      $
      \ UnicodeEscapeSequence
      <ZWNJ> <ZWJ>

    UnicodeIDStart::
      any Unicode code point with the Unicode property "ID_Start"

    UnicodeIDContinue::
      any Unicode code point with the Unicode property "ID_Continue"


    NOTE 3
    The sets of code points with Unicode properties "ID_Start" and
    "ID_Continue" include, respectively, the code points with Unicode
    properties "Other_ID_Start" and "Other_ID_Continue".

---*/


class C {
  static async #$(value) {
    return await value;
  }
  static async #_(value) {
    return await value;
  }
  static async #\u{6F}(value) {
    return await value;
  }
  static async #\u2118(value) {
    return await value;
  }
  static async #ZW_\u200C_NJ(value) {
    return await value;
  }
  static async #ZW_\u200D_J(value) {
    return await value;
  }
  foo = "foobar"
  bar = "barbaz";
  static async $(value) {
    return await this.#$(value);
  }
  static async _(value) {
    return await this.#_(value);
  }
  static async \u{6F}(value) {
    return await this.#\u{6F}(value);
  }
  static async \u2118(value) {
    return await this.#\u2118(value);
  }
  static async ZW_\u200C_NJ(value) {
    return await this.#ZW_\u200C_NJ(value);
  }
  static async ZW_\u200D_J(value) {
    return await this.#ZW_\u200D_J(value);
  }

}

var c = new C();

assert.sameValue(c.foo, "foobar");
assert.sameValue(Object.hasOwnProperty.call(C, "foo"), false);
assert.sameValue(Object.hasOwnProperty.call(C.prototype, "foo"), false);

verifyProperty(c, "foo", {
  value: "foobar",
  enumerable: true,
  configurable: true,
  writable: true,
});

assert.sameValue(c.bar, "barbaz");
assert.sameValue(Object.hasOwnProperty.call(C, "bar"), false);
assert.sameValue(Object.hasOwnProperty.call(C.prototype, "bar"), false);

verifyProperty(c, "bar", {
  value: "barbaz",
  enumerable: true,
  configurable: true,
  writable: true,
});

Promise.all([
  C.$(1),
  C._(1),
  C.\u{6F}(1),
  C.\u2118(1),
  C.ZW_\u200C_NJ(1),
  C.ZW_\u200D_J(1),
]).then(results => {

  assert.sameValue(results[0], 1);
  assert.sameValue(results[1], 1);
  assert.sameValue(results[2], 1);
  assert.sameValue(results[3], 1);
  assert.sameValue(results[4], 1);
  assert.sameValue(results[5], 1);

}, $DONE).then($DONE, $DONE);

