const fs = require("fs");
const stores = require("./stores");

const STORE_KEYS = Object.keys(stores);

function currentDate() {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const day = String(currentDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file));
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getCanonicalFor(store, rawItems, today) {
    const canonicalItems = [];
    for (let i = 0; i < rawItems.length; i++) {
        const item = stores[store]?.getCanonical(rawItems[i], today);
        if (item)
            canonicalItems.push({
                store,
                ...item
            });
    }
    return canonicalItems;
}

function mergePriceHistory(oldItems, items) {
    if (oldItems == null) return items;

    const lookup = {}
    for (oldItem of oldItems) {
        lookup[oldItem.store + oldItem.id] = oldItem;
    }

    for (item of items) {
        let oldItem = lookup[item.store + item.id];
        delete lookup[item.store + item.id];
        let currPrice = item.priceHistory[0];
        if (oldItem) {
            if (oldItem.priceHistory[0].price == currPrice.price) {
                item.priceHistory = oldItem.priceHistory;
                continue;
            }

            for (oldPrice of oldItem.priceHistory) {
                item.priceHistory.push(oldPrice);
            }
        }
    }

    console.log(`${Object.keys(lookup).length} not in latest list.`)
    for (key of Object.keys(lookup)) {
        items.push(lookup[key]);
    }

    sortItems(items);
    console.log(`Items: ${items.length}`);

    return items;
}

function sortItems(items) {
    items.sort((a, b) => {
        if (a.store < b.store) {
            return -1;
        } else if (a.store > b.store) {
            return 1;
        }

        if (a.name < b.name) {
            return -1;
        } else if (a.name > b.name) {
            return 1;
        }

        return 0;
    });
}

/// Given a directory of raw data of the form `$store-$date.json`, constructs
/// a canonical list of all products and their historical price data.
exports.replay = function(rawDataDir) {
    const today = currentDate();

    const files = fs.readdirSync(rawDataDir).filter(
        file => file.indexOf("canonical") == -1 &&
        STORE_KEYS.some(store => file.indexOf(`${store}-`) == 0)
    );

    const dateSort = (a, b) => {
        const dateA = new Date(a.match(/\d{4}-\d{2}-\d{2}/)[0]);
        const dateB = new Date(b.match(/\d{4}-\d{2}-\d{2}/)[0]);
        return dateA - dateB;
    };

    const getFilteredFilesFor = (store) => files.filter(file => file.indexOf(`${store}-`) == 0).sort(dateSort).map(file => rawDataDir + "/" + file);

    const storeFiles = {};
    const canonicalFiles = {};

    for(const store of STORE_KEYS) {
        storeFiles[store] = getFilteredFilesFor(store);
        canonicalFiles[store] = storeFiles[store].map(file => getCanonicalFor(store, readJSON(file), file.match(/\d{4}-\d{2}-\d{2}/)[0]));
        canonicalFiles[store].reverse();
    }

    const allFilesCanonical = [];
    const len = Math.max(...Object.values(canonicalFiles).map(filesByStore => filesByStore.length));
    for (let i = 0; i < len; i++) {
        const canonical = [];
        Object.values(canonicalFiles).forEach(filesByStore => {
            const file = filesByStore.pop();
            if (file) canonical.push(...file);
        })
        allFilesCanonical.push(canonical);
    }

    if (allFilesCanonical.length == 0) return null;
    if (allFilesCanonical.length == 1) return allFilesCanonical[0];

    let prev = allFilesCanonical[0];
    let curr = null;
    for (let i = 1; i < allFilesCanonical.length; i++) {
        curr = allFilesCanonical[i];
        mergePriceHistory(prev, curr);
        prev = curr;
    }
    return curr;
}

exports.updateData = async function (dataDir, done) {
    const today = currentDate();
    console.log("Fetching data for date: " + today);
    const storeFetchPromises = []
    for(const store of STORE_KEYS) {
        storeFetchPromises.push(new Promise(async (resolve) => {
            const start = performance.now();
            try {
                const storeItems = await stores[store].fetchData();
                fs.writeFileSync(`${dataDir}/${store}-${today}.json`, JSON.stringify(storeItems, null, 2));
                const storeItemsCanonical = getCanonicalFor(store, storeItems, today);
                console.log(`Fetched ${store.toUpperCase()} data, took ${(performance.now() - start) / 1000} seconds`);
                resolve(storeItemsCanonical)
            } catch (e) {
                console.error(`Error while fetching data from ${store}, continuing after ${(performance.now() - start) / 1000} seconds...`, e);
                resolve([])
            }
        }));
    }

    const items = [].concat(...await Promise.all(storeFetchPromises));

    if (fs.existsSync(`${dataDir}/latest-canonical.json`)) {
        const oldItems = JSON.parse(fs.readFileSync(`${dataDir}/latest-canonical.json`));
        mergePriceHistory(oldItems, items);
        console.log("Merged price history");
    }

    sortItems(items);
    fs.writeFileSync(`${dataDir}/latest-canonical.json`, JSON.stringify(items, null, 2));

    if (done) done(items);
    return items;
}
