/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/**
 * @fileOverview
 * This module is used for storing changes to settings that are
 * requested by extensions, and for finding out what the current value
 * of a setting should be, based on the precedence chain.
 *
 * When multiple extensions request to make a change to a particular
 * setting, the most recently installed extension will be given
 * precedence.
 *
 * This precedence chain of settings is stored in JSON format,
 * without indentation, using UTF-8 encoding.
 * With indentation applied, the file would look like this:
 *
 * {
 *   type: { // The type of settings being stored in this object, i.e., prefs.
 *     key: { // The unique key for the setting.
 *       initialValue, // The initial value of the setting.
 *       precedenceList: [
 *         {
 *           id, // The id of the extension requesting the setting.
 *           installDate, // The install date of the extension, stored as a number.
 *           value, // The value of the setting requested by the extension.
 *           enabled // Whether the setting is currently enabled.
 *         }
 *       ],
 *     },
 *     key: {
 *       // ...
 *     }
 *   }
 * }
 *
 */

var EXPORTED_SYMBOLS = ["ExtensionSettingsStore"];

const {OS} = ChromeUtils.import("resource://gre/modules/osfile.jsm");
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.defineModuleGetter(this, "AddonManager",
                               "resource://gre/modules/AddonManager.jsm");
ChromeUtils.defineModuleGetter(this, "JSONFile",
                               "resource://gre/modules/JSONFile.jsm");

const JSON_FILE_NAME = "extension-settings.json";
const JSON_FILE_VERSION = 2;
const STORE_PATH = OS.Path.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, JSON_FILE_NAME);

let _initializePromise;
let _store = {};

// Processes the JSON data when read from disk to convert string dates into numbers.
function dataPostProcessor(json) {
  if (json.version !== JSON_FILE_VERSION) {
    for (let storeType in json) {
      for (let setting in json[storeType]) {
        for (let extData of json[storeType][setting].precedenceList) {
          if (typeof extData.installDate != "number") {
            extData.installDate = new Date(extData.installDate).valueOf();
          }
        }
      }
    }
    json.version = JSON_FILE_VERSION;
  }
  return json;
}

// Loads the data from the JSON file into memory.
function initialize() {
  if (!_initializePromise) {
    _store = new JSONFile({
      path: STORE_PATH,
      dataPostProcessor,
    });
    _initializePromise = _store.load();
  }
  return _initializePromise;
}

// Test-only method to force reloading of the JSON file.
async function reloadFile(saveChanges) {
  if (!saveChanges) {
    // Disarm the saver so that the current changes are dropped.
    _store._saver.disarm();
  }
  await _store.finalize();
  _initializePromise = null;
  return initialize();
}

// Checks that the store is ready and that the requested type exists.
function ensureType(type) {
  if (!_store.dataReady) {
    throw new Error(
      "The ExtensionSettingsStore was accessed before the initialize promise resolved.");
  }

  // Ensure a property exists for the given type.
  if (!_store.data[type]) {
    _store.data[type] = {};
  }
}

/**
 * Return an object with properties for key, value|initialValue, id|null, or
 * null if no setting has been stored for that key.
 *
 * If no id is passed then return the highest priority item for the key.
 *
 * @param {string} type
 *        The type of setting to be retrieved.
 * @param {string} key
 *        A string that uniquely identifies the setting.
 * @param {string} id
 *        The id of the extension for which the item is being retrieved.
 *        If no id is passed, then the highest priority item for the key
 *        is returned.
 *
 * @returns {object | null}
 *          Either an object with properties for key and value, or
 *          null if no key is found.
 */
function getItem(type, key, id) {
  ensureType(type);

  let keyInfo = _store.data[type][key];
  if (!keyInfo) {
    return null;
  }

  if (id) {
    // Return the item that corresponds to the extension with id of id.
    let item = keyInfo.precedenceList.find(item => item.id === id);
    return item ? {key, value: item.value, id} : null;
  }

  // Find the highest precedence, enabled setting.
  for (let item of keyInfo.precedenceList) {
    if (item.enabled) {
      return {key, value: item.value, id: item.id};
    }
  }

  // Nothing found in the precedenceList, return the initialValue.
  return {key, initialValue: keyInfo.initialValue};
}

// Comparator used when sorting the precedence list.
function precedenceComparator(a, b) {
  if (a.enabled && !b.enabled) {
    return -1;
  }
  if (b.enabled && !a.enabled) {
    return 1;
  }
  return b.installDate - a.installDate;
}

/**
 * Helper method that alters a setting, either by changing its enabled status
 * or by removing it.
 *
 * @param {string} id
 *        The id of the extension for which a setting is being removed/disabled.
 * @param {string} type
 *        The type of setting to be altered.
 * @param {string} key
 *        A string that uniquely identifies the setting.
 * @param {string} action
 *        The action to perform on the setting.
 *        Will be one of remove|enable|disable.
 *
 * @returns {object | null}
 *          Either an object with properties for key and value, which
 *          corresponds to the current top precedent setting, or null if
 *          the current top precedent setting has not changed.
 */
function alterSetting(id, type, key, action) {
  let returnItem;
  ensureType(type);

  let keyInfo = _store.data[type][key];
  if (!keyInfo) {
    if (action === "remove") {
      return null;
    }
    throw new Error(
      `Cannot alter the setting for ${type}:${key} as it does not exist.`);
  }

  let foundIndex = keyInfo.precedenceList.findIndex(item => item.id == id);

  if (foundIndex === -1) {
    if (action === "remove") {
      return null;
    }
    throw new Error(
      `Cannot alter the setting for ${type}:${key} as it does not exist.`);
  }

  switch (action) {
    case "remove":
      keyInfo.precedenceList.splice(foundIndex, 1);
      break;

    case "enable":
      keyInfo.precedenceList[foundIndex].enabled = true;
      keyInfo.precedenceList.sort(precedenceComparator);
      foundIndex = keyInfo.precedenceList.findIndex(item => item.id == id);
      break;

    case "disable":
      keyInfo.precedenceList[foundIndex].enabled = false;
      keyInfo.precedenceList.sort(precedenceComparator);
      break;

    default:
      throw new Error(`${action} is not a valid action for alterSetting.`);
  }

  if (foundIndex === 0) {
    returnItem = getItem(type, key);
  }

  if (action === "remove" && keyInfo.precedenceList.length === 0) {
    delete _store.data[type][key];
  }

  _store.saveSoon();

  return returnItem;
}

var ExtensionSettingsStore = {
  /**
   * Loads the JSON file for the SettingsStore into memory.
   * The promise this returns must be resolved before asking the SettingsStore
   * to perform any other operations.
   *
   * @returns {Promise}
   *          A promise that resolves when the Store is ready to be accessed.
   */
  initialize() {
    return initialize();
  },

  /**
   * Adds a setting to the store, possibly returning the current top precedent
   * setting.
   *
   * @param {string} id
   *        The id of the extension for which a setting is being added.
   * @param {string} type
   *        The type of setting to be stored.
   * @param {string} key
   *        A string that uniquely identifies the setting.
   * @param {string} value
   *        The value to be stored in the setting.
   * @param {function} initialValueCallback
   *        A function to be called to determine the initial value for the
   *        setting. This will be passed the value in the callbackArgument
   *        argument. If omitted the initial value will be undefined.
   * @param {any} callbackArgument
   *        The value to be passed into the initialValueCallback. It defaults to
   *        the value of the key argument.
   *
   * @returns {object | null} Either an object with properties for key and
   *                          value, which corresponds to the item that was
   *                          just added, or null if the item that was just
   *                          added does not need to be set because it is not
   *                          at the top of the precedence list.
   */
  async addSetting(id, type, key, value, initialValueCallback = () => undefined, callbackArgument = key) {
    if (typeof initialValueCallback != "function") {
      throw new Error("initialValueCallback must be a function.");
    }

    ensureType(type);

    if (!_store.data[type][key]) {
      // The setting for this key does not exist. Set the initial value.
      let initialValue = await initialValueCallback(callbackArgument);
      _store.data[type][key] = {
        initialValue,
        precedenceList: [],
      };
    }
    let keyInfo = _store.data[type][key];
    // Check for this item in the precedenceList.
    let foundIndex = keyInfo.precedenceList.findIndex(item => item.id == id);
    if (foundIndex === -1) {
      // No item for this extension, so add a new one.
      let addon = await AddonManager.getAddonByID(id);
      keyInfo.precedenceList.push(
        {id, installDate: addon.installDate.valueOf(), value, enabled: true});
    } else {
      // Item already exists or this extension, so update it.
      let item = keyInfo.precedenceList[foundIndex];
      item.value = value;
      // Ensure the item is enabled.
      item.enabled = true;
    }

    // Sort the list.
    keyInfo.precedenceList.sort(precedenceComparator);

    _store.saveSoon();

    // Check whether this is currently the top item.
    if (keyInfo.precedenceList[0].id == id) {
      return {id, key, value};
    }
    return null;
  },

  /**
   * Removes a setting from the store, possibly returning the current top
   * precedent setting.
   *
   * @param {string} id
   *        The id of the extension for which a setting is being removed.
   * @param {string} type
   *        The type of setting to be removed.
   * @param {string} key
   *        A string that uniquely identifies the setting.
   *
   * @returns {object | null}
   *          Either an object with properties for key and value, which
   *          corresponds to the current top precedent setting, or null if
   *          the current top precedent setting has not changed.
   */
  removeSetting(id, type, key) {
    return alterSetting(id, type, key, "remove");
  },

  /**
   * Enables a setting in the store, possibly returning the current top
   * precedent setting.
   *
   * @param {string} id
   *        The id of the extension for which a setting is being enabled.
   * @param {string} type
   *        The type of setting to be enabled.
   * @param {string} key
   *        A string that uniquely identifies the setting.
   *
   * @returns {object | null}
   *          Either an object with properties for key and value, which
   *          corresponds to the current top precedent setting, or null if
   *          the current top precedent setting has not changed.
   */
  enable(id, type, key) {
    return alterSetting(id, type, key, "enable");
  },

  /**
   * Disables a setting in the store, possibly returning the current top
   * precedent setting.
   *
   * @param {string} id
   *        The id of the extension for which a setting is being disabled.
   * @param {string} type
   *        The type of setting to be disabled.
   * @param {string} key
   *        A string that uniquely identifies the setting.
   *
   * @returns {object | null}
   *          Either an object with properties for key and value, which
   *          corresponds to the current top precedent setting, or null if
   *          the current top precedent setting has not changed.
   */
  disable(id, type, key) {
    return alterSetting(id, type, key, "disable");
  },

  /**
   * Mark a setting as being controlled by a user's choice. This will disable all of
   * the extension defined values for the extension.
   *
   * @param {string} type The type of the setting.
   * @param {string} key The key of the setting.
   */
  setByUser(type, key) {
    let {precedenceList} = (_store.data[type] && _store.data[type][key]) || {};
    if (!precedenceList) {
      // The setting for this key does not exist. Nothing to do.
      return;
    }

    for (let item of precedenceList) {
      item.enabled = false;
    }

    _store.saveSoon();
  },

  /**
   * Retrieves all settings from the store for a given extension.
   *
   * @param {string} id
   *        The id of the extension for which a settings are being retrieved.
   * @param {string} type
   *        The type of setting to be returned.
   *
   * @returns {array}
   *          A list of settings which have been stored for the extension.
   */
  getAllForExtension(id, type) {
    ensureType(type);

    let keysObj = _store.data[type];
    let items = [];
    for (let key in keysObj) {
      if (keysObj[key].precedenceList.find(item => item.id == id)) {
        items.push(key);
      }
    }
    return items;
  },

  /**
   * Retrieves a setting from the store, either for a specific extension,
   * or current top precedent setting for the key.
   *
   * @param {string} type The type of setting to be returned.
   * @param {string} key A string that uniquely identifies the setting.
   * @param {string} id
   *        The id of the extension for which the setting is being retrieved.
   *        Defaults to undefined, in which case the top setting is returned.
   *
   * @returns {object} An object with properties for key, value and id.
   */
  getSetting(type, key, id) {
    return getItem(type, key, id);
  },

  /**
   * Returns whether an extension currently has a stored setting for a given
   * key.
   *
   * @param {string} id The id of the extension which is being checked.
   * @param {string} type The type of setting to be checked.
   * @param {string} key A string that uniquely identifies the setting.
   *
   * @returns {boolean} Whether the extension currently has a stored setting.
   */
  hasSetting(id, type, key) {
    return this.getAllForExtension(id, type).includes(key);
  },

  /**
   * Return the levelOfControl for a key / extension combo.
   * levelOfControl is required by Google's ChromeSetting prototype which
   * in turn is used by the privacy API among others.
   *
   * It informs a caller of the state of a setting with respect to the current
   * extension, and can be one of the following values:
   *
   * controlled_by_other_extensions: controlled by extensions with higher precedence
   * controllable_by_this_extension: can be controlled by this extension
   * controlled_by_this_extension: controlled by this extension
   *
   * @param {string} id
   *        The id of the extension for which levelOfControl is being requested.
   * @param {string} type
   *        The type of setting to be returned. For example `pref`.
   * @param {string} key
   *        A string that uniquely identifies the setting, for example, a
   *        preference name.
   *
   * @returns {string}
   *          The level of control of the extension over the key.
   */
  async getLevelOfControl(id, type, key) {
    ensureType(type);

    let keyInfo = _store.data[type][key];
    if (!keyInfo || !keyInfo.precedenceList.length) {
      return "controllable_by_this_extension";
    }

    let enabledItems = keyInfo.precedenceList.filter(item => item.enabled);
    if (!enabledItems.length) {
      return "controllable_by_this_extension";
    }

    let topItem = enabledItems[0];
    if (topItem.id == id) {
      return "controlled_by_this_extension";
    }

    let addon = await AddonManager.getAddonByID(id);
    return topItem.installDate > addon.installDate.valueOf() ?
      "controlled_by_other_extensions" :
      "controllable_by_this_extension";
  },

  /**
   * Test-only method to force reloading of the JSON file.
   *
   * Note that this method simply clears the local variable that stores the
   * file, so the next time the file is accessed it will be reloaded.
   *
   * @param   {boolean} saveChanges
   *          When false, discard any changes that have been made since the last
   *          time the store was saved.
   * @returns {Promise}
   *          A promise that resolves once the settings store has been cleared.
   */
  _reloadFile(saveChanges = true) {
    return reloadFile(saveChanges);
  },
};
