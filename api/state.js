const { readState } = require("../lib/storage");

module.exports = async function handler(req, res) {
  try {
    const state = await readState();

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      ...state,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
