import { useClerk, useUser } from "@clerk/react";
import { UserRound } from "lucide-react";

/** Rundes Konto-Icon in der Kopfzeile, öffnet Clerks Kontoverwaltung. */
export function AccountButton() {
  const { user } = useUser();
  const clerk = useClerk();

  if (!user) {
    return null;
  }

  const email = user.primaryEmailAddress?.emailAddress;

  return (
    <button
      type="button"
      onClick={() => clerk.openUserProfile()}
      aria-label="Konto verwalten"
      title={email ? `Konto verwalten (${email})` : "Konto verwalten"}
      className="pill-button pill-button--quiet h-11 w-11 justify-center overflow-hidden p-0"
    >
      {user.hasImage ? (
        <img
          src={user.imageUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <UserRound size={18} aria-hidden="true" />
      )}
    </button>
  );
}
