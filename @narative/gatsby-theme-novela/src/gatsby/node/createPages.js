/* eslint-disable no-console, import/no-extraneous-dependencies, prefer-const, no-shadow */

require('dotenv').config();

const log = (message, section) =>
  console.log(`\n\u001B[36m${message} \u001B[4m${section}\u001B[0m\u001B[0m\n`);

const path = require('path');
const createPaginatedPages = require('gatsby-paginate');

const templatesDirectory = path.resolve(__dirname, '../../templates');
const templates = {
  articles: path.resolve(templatesDirectory, 'articles.template.tsx'),
  article: path.resolve(templatesDirectory, 'article.template.tsx'),
  author: path.resolve(templatesDirectory, 'author.template.tsx'),
  tag: path.resolve(templatesDirectory, 'tag.template.tsx'),
};

const query = require('../data/data.query');
const normalize = require('../data/data.normalize');

// ///////////////// Utility functions ///////////////////

function buildPaginatedPath(index, basePath) {
  if (basePath === '/') {
    return index > 1 ? `${basePath}page/${index}` : basePath;
  }
  return index > 1 ? `${basePath}/page/${index}` : basePath;
}

function slugify(string, base) {
  const slug = string
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

  return `${base}/${slug}`.replace(/\/\/+/g, '/');
}

function getUniqueListBy(array, key) {
  return [...new Map(array.map((item) => [item[key], item])).values()];
}

function diff_days(dt2, dt1) {
  var diff = (dt2.getTime() - dt1.getTime()) / 1000;
  diff /= 3600;
  diff /= 24;
  return Math.abs(Math.round(diff));
}

const byDate = (a, b) => new Date(b.dateForSEO) - new Date(a.dateForSEO);

// ///////////////////////////////////////////////////////

module.exports = async ({ actions: { createPage }, graphql }, themeOptions) => {
  const {
    rootPath,
    basePath = '/',
    authorsPath = '/authors',
    tagPath = '/tag',
    authorsPage = true,
    pageLength = 6,
    sources = {},
    mailchimp = false,
    tags = false,
  } = themeOptions;

  const { data } = await graphql(`
    query siteQuery {
      site {
        siteMetadata {
          siteUrl
        }
      }
    }
  `);

  console.log(sources);
  // Defaulting to look at the local MDX files as sources.
  const { local = true, contentful = false } = sources;

  let authors;
  let articles;

  const dataSources = {
    local: { authors: [], articles: [] },
    contentful: { authors: [], articles: [] },
    netlify: { authors: [], articles: [] },
  };

  if (rootPath) {
    log('Config rootPath', rootPath);
  } else {
    log('Config rootPath not set, using basePath instead =>', basePath);
  }

  log('Config basePath', basePath);
  if (authorsPage) log('Config authorsPath', authorsPath);

  if (local) {
    try {
      log('Querying Authors & Articles source:', 'Local');
      const localAuthors = await graphql(query.local.authors);
      const localArticles = await graphql(query.local.articles);

      dataSources.local.authors = localAuthors.data.authors.edges.map(
        normalize.local.authors,
      );

      dataSources.local.articles = localArticles.data.articles.edges.map(
        normalize.local.articles,
      );
    } catch (error) {
      console.error(error);
    }
  }

  if (contentful) {
    try {
      log('Querying Authors & Articles source:', 'Contentful');
      const contentfulAuthors = await graphql(query.contentful.authors);
      const contentfulArticles = await graphql(query.contentful.articles);

      dataSources.contentful.authors = contentfulAuthors.data.authors.edges.map(
        normalize.contentful.authors,
      );

      dataSources.contentful.articles = contentfulArticles.data.articles.edges.map(
        normalize.contentful.articles,
      );
    } catch (error) {
      console.error(error);
    }
  }

  // Combining together all the articles from different sources
  articles = [
    ...dataSources.local.articles,
    ...dataSources.contentful.articles,
    ...dataSources.netlify.articles,
  ].sort(byDate);

  const articlesThatArentDraft = articles.filter((article) => !article.draft);
  const articlesThatArentSecret = articlesThatArentDraft.filter(
    (article) => !article.secret,
  );

  // Combining together all the authors from different sources
  authors = getUniqueListBy(
    [
      ...dataSources.local.authors,
      ...dataSources.contentful.authors,
      ...dataSources.netlify.authors,
    ],
    'name',
  );

  if (articles.length === 0 || authors.length === 0) {
    throw new Error(`
    You must have at least one Author and Post. As reference you can view the
    example repository. Look at the content folder in the example repo.
    https://github.com/narative/gatsby-theme-novela-example
  `);
  }

  /**
   * Once we've queried all our data sources and normalized them to the same structure
   * we can begin creating our pages. First, we'll want to create all main articles pages
   * that have pagination.
   * /articles
   * /articles/page/1
   * ...
   */
  log('Creating', 'articles page');
  createPaginatedPages({
    edges: articlesThatArentSecret,
    pathPrefix: basePath,
    createPage,
    pageLength,
    pageTemplate: templates.articles,
    buildPath: buildPaginatedPath,
    context: {
      authors,
      basePath,
      skip: pageLength,
      limit: pageLength,
      tags,
    },
  });

  /**
   * Once the list of articles have bene created, we need to make individual article posts.
   * To do this, we need to find the corresponding authors since we allow for co-authors.
   */
  log('Creating', 'article posts');
  articlesThatArentDraft.forEach((article, index) => {
    // Match the Author to the one specified in the article
    let authorsThatWroteTheArticle;
    try {
      authorsThatWroteTheArticle = authors.filter((author) => {
        const allAuthors = article.author
          .split(',')
          .map((a) => a.trim().toLowerCase());

        return allAuthors.some((a) => a === author.name.toLowerCase());
      });
    } catch (error) {
      throw new Error(`
        We could not find the Author for: "${article.title}".
        Double check the author field is specified in your post and the name
        matches a specified author.
        Provided author: ${article.author}
        ${error}
      `);
    }

    /**
     * We need a way to find the next articles to suggest at the bottom of the articles page.
     * To accomplish this there is some special logic surrounding what to show next.
     */
    let OtherArticlesThatArentSecretSorted = articlesThatArentSecret
      .filter((art) => art !== article)
      .sort((a, b) => {
        const allTags = article.tags.map((t) => t.trim().toLowerCase());
        const allATags = a.tags.map((t) => t.trim().toLowerCase());
        const allBTags = b.tags.map((t) => t.trim().toLowerCase());
        let intersectionA = allATags.filter((x) => allTags.includes(x));
        let intersectionB = allBTags.filter((x) => allTags.includes(x));

        let num_days_A = diff_days(
          new Date(a.dateForSEO),
          new Date(article.dateForSEO),
        );
        let num_days_B = diff_days(
          new Date(b.dateForSEO),
          new Date(article.dateForSEO),
        );

        return (
          intersectionB.length - intersectionA.length || num_days_A - num_days_B
        );
      });

    let next = OtherArticlesThatArentSecretSorted.slice(0, 2);
    if (next.length === 0)
      next = articlesThatArentSecret.slice(index + 1, index + 3);

    if (next.length === 1 && OtherArticlesThatArentSecretSorted.length !== 2)
      next = [
        ...next,
        OtherArticlesThatArentSecretSorted.filter((art) => art !== next[0])[0],
      ];

    // If it's the last item in the list, there will be no articles. So grab the first 2
    if (next.length === 0) next = articlesThatArentSecret.slice(0, 2);
    // If there's 1 item in the list, grab the first article
    if (next.length === 1 && articlesThatArentSecret.length !== 2)
      next = [...next, articlesThatArentSecret[0]];
    if (articlesThatArentSecret.length === 1) next = [];

    // next and prev article links

    // next article
    let nextPage;
    if (index === 0) {
      nextPage = null;
    } else {
      idx = index - 1;
      temp = articlesThatArentDraft[idx];
      while (temp.secret) {
        idx = idx - 1;
        if (idx === -1) {
          temp = null;
          break;
        }
        temp = articlesThatArentDraft[idx];
      }
      nextPage = temp;
    }

    //  prev article
    let prevPage;
    if (index === articlesThatArentDraft.length - 1) {
      prevPage = null;
    } else {
      idx = index + 1;
      temp = articlesThatArentDraft[idx];
      while (temp.secret) {
        idx = idx + 1;
        if (idx === articlesThatArentDraft.length) {
          temp = null;
          break;
        }
        temp = articlesThatArentDraft[idx];
      }
      prevPage = temp;
    }

    createPage({
      path: article.slug,
      component: templates.article,
      context: {
        article,
        authors: authorsThatWroteTheArticle,
        basePath,
        permalink: `${data.site.siteMetadata.siteUrl}/${article.slug}/`,
        slug: article.slug,
        id: article.id,
        title: article.title,
        canonicalUrl: article.canonical_url,
        mailchimp,
        next,
        nextPage,
        prevPage,
        tags,
      },
    });
  });

  /**
   * By default the author's page is not enabled. This can be enabled through the theme options.
   * If enabled, each author will get their own page and a list of the articles they have written.
   */
  if (authorsPage) {
    log('Creating', 'authors page');

    authors.forEach((author) => {
      const articlesTheAuthorHasWritten = articlesThatArentSecret.filter(
        (article) =>
          article.author.toLowerCase().includes(author.name.toLowerCase()),
      );
      const path = slugify(author.slug, authorsPath);

      createPaginatedPages({
        edges: articlesTheAuthorHasWritten,
        pathPrefix: author.slug,
        createPage,
        pageLength,
        pageTemplate: templates.author,
        buildPath: buildPaginatedPath,
        context: {
          author,
          originalPath: path,
          skip: pageLength,
          limit: pageLength,
          tags,
        },
      });
    });
  }

  if (tags) {
    const uniqueTags = [
      ...new Set(
        articlesThatArentDraft.reduce((accumulator, article) => {
          return [...accumulator, ...article.tags];
        }, []),
      ),
    ];

    if (uniqueTags.length > 0) {
      // TODO: need to implements, [/tag] page.
      // log('Creating', 'tags pages');

      /**
       * Creating main tag pages example
       *  /tag/gatsby
       *  /tag/gatsby/2
       */
      log('Creating', 'tag pages');
      uniqueTags.forEach((tag) => {
        let allArticlesOfTheTag;
        try {
          allArticlesOfTheTag = articlesThatArentDraft.filter((article) =>
            article.tags.includes(tag),
          );
        } catch (error) {
          throw new Error(`
            We could not find the Articles for: "${tag}".
            Double check the tags field is specified in your post and the name matches a specified tag.
            Tag name: ${tag}
            ${error}
          `);
        }

        const path = slugify(tag, tagPath);

        createPaginatedPages({
          edges: allArticlesOfTheTag,
          pathPrefix: path,
          createPage,
          pageLength,
          pageTemplate: templates.tag,
          buildPath: buildPaginatedPath,
          context: {
            tag,
            originalPath: path,
            skip: pageLength,
            limit: pageLength,
          },
        });
      });
    }
  }
};
