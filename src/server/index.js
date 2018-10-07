import '../env';

import path from 'path';

import express from 'express';
import favicon from 'serve-favicon';
import next from 'next';
import { get } from 'lodash';
import * as api from './api';
import routes from '../routes';
import logger from '../logger';
import { titleCase } from '../lib/utils';
import { registerToNewsletter } from '../lib/mailchimp';
import listsData from '../../data/lists.json';
import citiesData from '../../data/cities.json';

const {
  PORT,
} = process.env;


let cities = [];
const citiesByZipcode = {};
api.getJSONFromCSVFile('cities').then(rows => {
  cities = rows;
  console.log(">>> loading", cities.length, "cities");
  cities.forEach(c => {
    citiesByZipcode[c.zipcode] = c.city;
  });
});

const port = parseInt(PORT, 10) || 3000;

const nextApp = next({
  dir: path.dirname(__dirname),
  dev: process.env.NODE_ENV !== 'production',
});

const handler = routes.getRequestHandler(nextApp);

const inc = (obj, key, increment = 1) => {
  obj[key] = obj[key] || 0;
  obj[key] += increment;
}

/**
 * Getting the right canonical zipcode is not trivial
 * 1000, 1020, 1120, 1130: Bruxelles ville
 * 1081: Koekelberg
 * 1082: Berchem-Sainte-Agathe
 * 1420, 1421, 1428: Braine-l'Alleud
 * 
 * @param {*} zipcode 
 */
const getCanonicalZipCode = (zipcode) => {
  const zc = Number(zipcode);
  if ([1000,1020,1120,1130].includes(zc)) return 1000;
  if (citiesByZipcode[zc]) return zc;
  let res;
  cities.forEach(c => {
    if (Math.floor(Number(c.zipcode)/10) === Math.floor(zc/10))
      res = Number(c.zipcode);
  });
  return res;
}
const getCityInfo = (zipcode) => citiesData.find(city => (Number(city.zipcode) === Number(zipcode)));

const getListInfo = (listname, zipcode) => {
  if (!listname) return;
  console.log(">>> getListInfo", listname, typeof zipcode, zipcode);
  for (let i=0; i< listsData.length; i++) {
    const list = listsData[i];
    if (list.sigle.toLowerCase() === listname.toLowerCase()) {
      if (!list.zipcode || Number(list.zipcode) === Number(zipcode)) return list;
    }
    if (listname.toLowerCase().indexOf(list.sigle.toLowerCase()) > -1) {
      return list;
    }
  }
  return null;
}


nextApp.prepare().then(() => {
  const server = express();

  server.use(
    favicon(path.join(path.dirname(__dirname), 'static', 'favicon.ico')),
  );

  server.use(express.json());

  server.post('/api/newsletter/register', (req, res) => {
    const email = get(req, 'body.email');
    const newsletter = get(req, 'body.newsletter');
    registerToNewsletter(email, newsletter).then(data => res.json(data));
  });

  server.get('/api/data/:csvfile', api.getDataFromCSV);

  server.get('/villes/:city', async (req, res, next) => {
    res.setHeader('Cache-Control', `public, max-age=${60 * 15}`); // cache for 15mn
    const city = req.params.city.toLowerCase();
    console.log(">>> getting candidates for", city);
    const csv = await api.getJSONFromCSVFile('candidates_with_cumuleo');
    console.log(">>> loading", csv.length, "rows from candidates_with_cumuleo.csv");
    const lists = {};
    let zipcode;
    const candidates = csv.filter(r => {
      if (r.city.toLowerCase() !== city) return false;
      // console.log(">>> keeping", r.firstname, r.lastname, r.list, r.zipcode, r.city);
      if (!zipcode) {
        zipcode = r.zipcode;
      }
      lists[r.list] = lists[r.list] || { candidates: [], totalPoliticians: 0, totalCumuls: 0, totalYearsInPolitics: 0 };
      lists[r.list].candidates.push(r);
      if (lists[r.list].info === undefined) {
        lists[r.list].info = getListInfo(r.list, r.zipcode);
      }
      if (!lists[r.list].party) {
        lists[r.list].party = r.party;
      }
      if (r.cumuleo_url) {
        inc(lists[r.list], 'totalPoliticians');
        inc(lists[r.list], 'totalCumuls', parseInt(r.cumuls_2017));
        for (let i = 2004; i < 2016; i++ ) {
          if (r[i]) {
            inc(lists[r.list], 'totalYearsInPolitics');
          }
        }
      }
      return true;
    });
    req.data = {
      city: {
        name: titleCase(city),
        zipcode,
        ...getCityInfo(zipcode)
      },
      lists
    };
    console.log(">>> data", req.data);
    next();
  });

  server.get('/villes/:city/:listname', async (req, res, next) => {
    res.setHeader('Cache-Control', `public, max-age=${60 * 15}`); // cache for 15mn
    const city = req.params.city.toLowerCase();
    const listname = req.params.listname.toLowerCase();
    console.log(">>> getting candidates for", city, listname);
    const csv = await api.getJSONFromCSVFile('candidates_with_cumuleo');
    const list = { name: listname, candidates: [] };
    const stats = { totalPoliticians: 0, totalCumuls: 0, parties: {} };
    const candidates = csv.filter(r => {
      if (r.city.toLowerCase() !== city) return false;
      if (r.list.toLowerCase() !== listname) return false;
      if (!list.zipcode) list.zipcode = r.zipcode;
      if (r.cumuleo_url) {
        inc(stats, 'totalPoliticians');
        inc(stats, 'totalCumuls', parseInt(r.cumuls_2017));
        inc(stats.parties, r.party);
        r.politicalYears = 0;
        for (let i = 2004; i < 2016; i++ ) {
          if (r[i]) {
            inc(stats, 'totalYearsInPolitics');
            r.politicalYears++;
          }
        }
      }
      list.candidates.push(r);
      return true;
    });
    list.candidates.sort((a, b) => (parseInt(a.position) > parseInt(b.position) ? 1 : -1));
    // we define list.party using using the first politician on the list
    list.candidates.map(c => {
      if (!list.party) {
        list.party = c.party;
      }
    })
    list.info = getListInfo(listname, list.zipcode);
    req.data = {
      city: {
        name: titleCase(city),
        zipcode: list.zipcode,
        ...getCityInfo(list.zipcode)
      },
      list,
      stats
    };
    next();
  });

  server.use('/static', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    next();
  });

  server.use('/_next/static', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    next();
  });

  server.get('/:zipcode', async (req, res, next) => {
    res.setHeader('Cache-Control', `public, max-age=${60 * 15}`); // cache for 15mn
    let zipcode = getCanonicalZipCode(req.params.zipcode);

    console.log(">>> getting candidates for", zipcode);
    const csv = await api.getJSONFromCSVFile('candidates_with_cumuleo');
    console.log(">>> loading", csv.length, "rows from candidates_with_cumuleo.csv");
    const lists = {};
    let city;
    const candidates = csv.filter(r => {
      if (Number(r.zipcode) !== zipcode) return false;
      if (!city) city = r.city;
      lists[r.list] = lists[r.list] || { candidates: [], totalPoliticians: 0, totalCumuls: 0, totalYearsInPolitics: 0 };
      lists[r.list].candidates.push(r);
      if (lists[r.list].info === undefined) {
        lists[r.list].info = getListInfo(r.list, r.zipcode);
      }
      if (!lists[r.list].party) {
        lists[r.list].party = r.party;
      }
      if (r.cumuleo_url) {
        inc(lists[r.list], 'totalPoliticians');
        inc(lists[r.list], 'totalCumuls', parseInt(r.cumuls_2017));
        for (let i = 2004; i < 2016; i++ ) {
          if (r[i]) {
            inc(lists[r.list], 'totalYearsInPolitics');
          }
        }
      }
      return true;
    });
    req.data = {
      city: {
        zipcode,
        name: titleCase(city),
        ...getCityInfo(zipcode)
      },
      lists
    };
    // console.log(">>> data", req.data);
    next();
  });

  server.get('*', handler);

  server.listen(port, err => {
    if (err) {
      throw err;
    }
    logger.info(`> Ready on http://localhost:${port}`);
  });
});