// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppConceptDoc, PdppConceptPage } from "@/components/pdpp-concept/concept-page.tsx";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { PdppFrontDoor } from "@/components/pdpp-concept/front-door.tsx";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";

export default function Home() {
  return (
    <div className="pdpp-concept">
      <PdppConceptMasthead />

      <PdppConceptPage home>
        <PdppConceptDoc>
          <PdppFrontDoor />
        </PdppConceptDoc>
      </PdppConceptPage>

      <PdppConceptFooter />
    </div>
  );
}
