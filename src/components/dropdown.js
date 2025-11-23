import React from "react";

const BRAND_OPTIONS = ["Bloomommy", "Cellumove", "Hermios", "Yuma", "Delvaux"];

function BrandDropdown({ selectedBrand, onChange }) {
  const groupName = "brand-select";

  const placeholderText = selectedBrand || "Select brand";

  return (
    <div className="brand-select">
      <label style={{ display: "block", marginBottom: 4 }}>Brand</label>

      <form
        className="brand-select-form"
        onSubmit={(e) => e.preventDefault()}
      >
        <ul className="select">
          {/* Top row: placeholder / current value */}
          <li>
            {/* "close" radio – used by CSS to collapse the dropdown */}
            <input
              className="select_close"
              type="radio"
              name={groupName}
              id={`${groupName}-close`}
              defaultChecked={!selectedBrand}
            />
            <span className="select_label select_label-placeholder">
              {placeholderText}
            </span>
          </li>

          {/* Items container (options + opener/closer radios) */}
          <li className="select_items">
            {/* "expand" radio – opens the dropdown */}
            <input
              className="select_expand"
              type="radio"
              name={groupName}
              id={`${groupName}-opener`}
            />
            {/* Clicking this label (overlay) closes dropdown */}
            <label
              className="select_closeLabel"
              htmlFor={`${groupName}-close`}
            ></label>

            {/* Options list */}
            <ul className="select_options">
              {BRAND_OPTIONS.map((brand) => {
                const id = `${groupName}-${brand.toLowerCase()}`;
                return (
                  <li className="select_option" key={brand}>
                    <input
                      className="select_input"
                      type="radio"
                      name={groupName}
                      id={id}
                      defaultChecked={selectedBrand === brand}
                      onChange={() => onChange(brand)}
                    />
                    <label className="select_label" htmlFor={id}>
                      {brand}
                    </label>
                  </li>
                );
              })}
            </ul>

            <label
              className="select_expandLabel"
              htmlFor={`${groupName}-opener`}
            ></label>
          </li>
        </ul>
      </form>
    </div>
  );
}

export default BrandDropdown;
