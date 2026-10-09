/*
 * Knex migrations ship with the package (see "files" in package.json), so they
 * end up in the backend bundle next to the compiled code.
 */

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('notices', table => {
    table.comment('Notices posted to the noticeboard');
    table.string('id').primary().notNullable();
    table.string('title').notNullable();
    table.text('body').notNullable();
    table
      .string('author')
      .notNullable()
      .comment('Entity ref of the user who posted the notice');
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.index(['created_at'], 'notices_created_at_idx');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('notices');
};
